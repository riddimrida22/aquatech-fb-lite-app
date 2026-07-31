"""
Data source — pulls live hours from AqtPM prod Postgres.

Pluggable: current implementation runs a query inside the prod backend container over
SSH (reuses the existing deploy key; no new setup). Returns:
  invoice_hours : {full_name: total hours on the invoiced project in [begin,end]}
  timesheet     : {full_name: [ {project, date (iso), hours, note} ]}  across ALL projects
The timesheet dict feeds the weekly backups; invoice_hours feeds the cost-plus engine.
"""
from __future__ import annotations
import json, os, subprocess, tempfile, datetime as dt
from config import SSH_KEY, SSH_HOST, DOCKER_BACKEND

_QUERY_TMPL = '''
import json, datetime as dt
from app.db import SessionLocal
from app.models import TimeEntry, User, Project
from sqlalchemy import select
db = SessionLocal()
INV_BEG = dt.date.fromisoformat("{begin}")
INV_END = dt.date.fromisoformat("{end}")
TS_BEG = dt.date.fromisoformat("{ts_begin}")
TS_END = dt.date.fromisoformat("{ts_end}")
PROJ = {project_id}
rows = db.execute(
    select(User.full_name, Project.name, TimeEntry.work_date, TimeEntry.hours,
           TimeEntry.note, TimeEntry.bill_rate_applied)
    .join(User, User.id==TimeEntry.user_id)
    .join(Project, Project.id==TimeEntry.project_id)
    .where(TimeEntry.work_date>=TS_BEG, TimeEntry.work_date<=TS_END)
    .order_by(User.full_name, TimeEntry.work_date)
).all()
invoice_hours = {{}}
timesheet = {{}}
bill_rates = {{}}
proj_name = db.execute(select(Project.name).where(Project.id==PROJ)).scalar_one_or_none()
for full_name, pname, d, hrs, notes, brate in rows:
    h = float(hrs or 0)
    timesheet.setdefault(full_name, []).append(
        {{"project": pname, "date": d.isoformat(), "hours": h, "note": notes or ""}})
    if pname == proj_name and INV_BEG <= d <= INV_END:
        invoice_hours[full_name] = round(invoice_hours.get(full_name, 0.0) + h, 2)
        if brate:
            bill_rates[full_name] = float(brate)
print("__JSON__" + json.dumps({{"invoice_hours": invoice_hours, "timesheet": timesheet,
                               "bill_rates": bill_rates, "project_name": proj_name}}))
db.close()
'''


_FB_LINES_TMPL = '''
import json, datetime as dt
from app.db import SessionLocal
from app.models import TimeEntry, User, Project, Task
from sqlalchemy import select
db = SessionLocal()
BEG = dt.date.fromisoformat("{begin}")
END = dt.date.fromisoformat("{end}")
PROJ = {project_id}
rows = db.execute(
    select(User.full_name, TimeEntry.work_date, TimeEntry.hours, TimeEntry.note,
           TimeEntry.bill_rate_applied, Task.name)
    .join(User, User.id==TimeEntry.user_id)
    .join(Project, Project.id==TimeEntry.project_id)
    .join(Task, Task.id==TimeEntry.task_id, isouter=True)
    .where(TimeEntry.project_id==PROJ, TimeEntry.work_date>=BEG, TimeEntry.work_date<=END)
    .order_by(TimeEntry.work_date, User.full_name)).all()
proj_name = db.execute(select(Project.name).where(Project.id==PROJ)).scalar_one_or_none()
out = []
for nm, d, h, note, br, task in rows:
    h = float(h or 0); br = float(br or 0)
    out.append(dict(person=nm, date=d.isoformat(), hours=h, note=note or "",
                    rate=br, task=task or "", amount=round(h*br, 2)))
print("__JSON__" + json.dumps({{"lines": out, "project_name": proj_name}}))
db.close()
'''


def pull_fb_lines(project_id: int, begin: dt.date, end: dt.date) -> dict:
    """Per-time-entry line items for the FreshBooks-style invoice: person, date, hours,
    note, loaded bill rate, task, amount."""
    q = _FB_LINES_TMPL.format(begin=begin.isoformat(), end=end.isoformat(), project_id=project_id)
    data = run_remote_query(q)
    for e in data["lines"]:
        e["date"] = dt.date.fromisoformat(e["date"])
    return data


_SUBTASK_TMPL = '''
import json, datetime as dt, re
from app.db import SessionLocal
from app.models import TimeEntry, User, Project, Task
from sqlalchemy import select
db = SessionLocal()
BEG = dt.date.fromisoformat("{begin}")
END = dt.date.fromisoformat("{end}")
PROJ = {project_id}
rows = db.execute(
    select(User.full_name, Task.name, TimeEntry.hours, TimeEntry.bill_rate_applied)
    .join(User, User.id==TimeEntry.user_id)
    .join(Task, Task.id==TimeEntry.task_id, isouter=True)
    .where(TimeEntry.project_id==PROJ, TimeEntry.work_date>=BEG, TimeEntry.work_date<=END)
).all()
by_sub = {{}}          # subtask_name -> {{full_name: hours}}
bill_rates = {{}}
for full_name, task, hrs, brate in rows:
    h = float(hrs or 0)
    if not h:
        continue
    key = task or "(no task)"
    by_sub.setdefault(key, {{}})
    by_sub[key][full_name] = round(by_sub[key].get(full_name, 0.0) + h, 2)
    if brate:
        bill_rates[full_name] = float(brate)
proj_name = db.execute(select(Project.name).where(Project.id==PROJ)).scalar_one_or_none()
print("__JSON__" + json.dumps({{"by_subtask": by_sub, "bill_rates": bill_rates,
                               "project_name": proj_name}}))
db.close()
'''


def pull_subtasks(project_id: int, begin: dt.date, end: dt.date) -> dict:
    """Hours grouped by (sub-task/task name -> {full_name: hours}) for a project+period,
    plus applied bill rates. Drives Stantec/JobCon (which bill per sub-task)."""
    q = _SUBTASK_TMPL.format(begin=begin.isoformat(), end=end.isoformat(), project_id=project_id)
    return run_remote_query(q)


def run_remote_query(query_code: str, marker: str = "__JSON__") -> dict:
    """Run a Python snippet inside the prod backend container over SSH and return the
    JSON it prints on a line starting with `marker`. Reusable by any query."""
    tmp = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, dir=tempfile.gettempdir())
    tmp.write(query_code); tmp.close()
    p = os.path.abspath(tmp.name)  # C:\.. -> /mnt/c/..
    wsl_local = "/mnt/" + p[0].lower() + p[2:].replace("\\", "/")
    remote = "/tmp/aqtpm_invoice_query.py"
    cmd = (
        f"cp '{wsl_local}' {remote} && "
        f"scp -i {SSH_KEY} -o ConnectTimeout=25 {remote} {SSH_HOST}:{remote} && "
        f"ssh -i {SSH_KEY} -o ConnectTimeout=40 {SSH_HOST} "
        f"'docker exec -i {DOCKER_BACKEND} python - < {remote}'"
    )
    out = subprocess.check_output(["wsl", "bash", "-lc", cmd], stderr=subprocess.STDOUT).decode()
    for line in out.splitlines():
        if line.startswith(marker):
            return json.loads(line[len(marker):])
    raise RuntimeError("no JSON marker in query output:\n" + out[-1500:])


def pull(project_id: int, begin: dt.date, end: dt.date,
         ts_begin: dt.date | None = None, ts_end: dt.date | None = None) -> dict:
    """invoice_hours computed over [begin,end]; timesheet rows over [ts_begin,ts_end]
    (defaults to the invoice period). Widen ts range to full week boundaries so weekly
    timesheets render complete. Also returns bill_rates {name: applied loaded rate}."""
    ts_begin = ts_begin or begin
    ts_end = ts_end or end
    q = _QUERY_TMPL.format(begin=begin.isoformat(), end=end.isoformat(),
                           ts_begin=ts_begin.isoformat(), ts_end=ts_end.isoformat(),
                           project_id=project_id)
    data = run_remote_query(q)
    for name, lst in data["timesheet"].items():
        for e in lst:
            e["date"] = dt.date.fromisoformat(e["date"])
    return data


if __name__ == "__main__":
    import io, sys
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    d = pull(4, dt.date(2026, 5, 3), dt.date(2026, 5, 30))
    print("project:", d["project_name"])
    print("invoice_hours:", d["invoice_hours"], "(expect Zachary 97 / Robert 20 / Bertrand 49)")
    print("timesheet employees:", list(d["timesheet"].keys()))
