"""Seed a FICTITIOUS marketing-demo dataset for AqtPM.

Run against a throwaway DB so prod is never touched:
    DATABASE_URL="sqlite:///./demo_aquatech.db" DEMO_DOMAIN="pinnacle-eng.com" python seed_demo.py

Builds one coherent story for a small engineering-consulting firm:
  people -> timesheets -> payroll  +  invoices (revenue/AR)  +  expenses  =>  profit dashboards.
All names/numbers are invented. No PII, no real financials.
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta
from decimal import Decimal

os.environ.setdefault("DATABASE_URL", "sqlite:///./demo_aquatech.db")
DOMAIN = os.environ.get("DEMO_DOMAIN", "pinnacle-eng.com")

from app import db as _db  # noqa: E402
from app import models as M  # noqa: E402  (also registers payroll models)
from app.payroll import models as PM  # noqa: E402
from app.payroll import service as payroll_service  # noqa: E402
from app.payroll.engine import EmployeeInput, cents  # noqa: E402

TODAY = date(2026, 9, 11)


def last_friday(d: date) -> date:
    return d - timedelta(days=(d.weekday() - 4) % 7 + (0 if d.weekday() >= 4 else 7))


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def reset_schema():
    # brand-new empty schema in the demo DB
    M.Base.metadata.drop_all(bind=_db.engine)
    _db.init_db()


# ---- fictitious roster -------------------------------------------------------
# (first, last, role, app_role, bill, cost, pay_rate_hourly, fed_status, ny_allow, k401)
PEOPLE = [
    ("Dana",   "Okafor",   "Principal / PM",   "admin",    210, 95, 96.0, "mfj",    2, 6),
    ("Marcus", "Reilly",   "Senior Engineer",  "manager",  175, 78, 74.0, "single", 1, 5),
    ("Priya",  "Nair",     "Project Engineer", "employee", 145, 62, 58.0, "single", 1, 4),
    ("Tyler",  "Brooks",   "CAD / Designer",   "employee", 120, 48, 45.0, "single", 0, 3),
    ("Sofia",  "Mendes",   "EIT",              "employee", 110, 44, 41.0, "single", 1, 3),
    ("Grace",  "Liu",      "Office Manager",   "employee",   0, 40, 36.0, "single", 2, 0),
]

# billable projects: (name, client, budget_fee, target_margin)
PROJECTS = [
    ("Riverside Bridge Rehabilitation", "Hudson County DOT",   248000, 0.42),
    ("Downtown Drainage Master Plan",   "City of Fairview",    166000, 0.40),
    ("Route 9 Corridor Traffic Study",  "Garden State DOT",     94000, 0.38),
    ("Lakeside WWTP Capacity Upgrade",  "Fairview Water Auth", 132000, 0.41),
]

TASKS = [  # per project: (task_name, [(subcode, subname, budget_hours, budget_fee)])
    ("Preliminary Design", [("100", "Data Collection", 80, 12000), ("110", "Concept Alternatives", 120, 21000)]),
    ("Final Design",       [("200", "Plans & Specs", 200, 42000), ("210", "QA/QC Review", 60, 12600)]),
    ("Permitting & Support", [("300", "Agency Coordination", 60, 10500)]),
]


def run():
    reset_schema()
    S = _db.SessionLocal()
    try:
        # ---- users + rates ------------------------------------------------
        users = {}
        for first, last, title, role, bill, cost, pay, fed, allow, k401 in PEOPLE:
            u = M.User(email=f"{first.lower()}.{last.lower()}@{DOMAIN}",
                       full_name=f"{first} {last}", role=role, is_active=True,
                       start_date=date(2024, 1, 15))
            S.add(u); S.flush()
            users[u.full_name] = u
            S.add(M.UserRate(user_id=u.id, effective_date=date(2025, 1, 1),
                             bill_rate=float(bill), cost_rate=float(cost)))
        S.flush()
        principal = users["Dana Okafor"]

        # ---- projects + tasks + subtasks + members ------------------------
        projects = []
        for pname, client, fee, margin in PROJECTS:
            p = M.Project(name=pname, client_name=client, pm_user_id=principal.id,
                          start_date=date(2026, 3, 1), overall_budget_fee=float(fee),
                          target_gross_margin_pct=margin, is_overhead=False,
                          is_billable=True, is_active=True, lifecycle_status="active",
                          source="manual")
            S.add(p); S.flush()
            projects.append(p)
            for uname in users:
                if uname != "Grace Liu":
                    S.add(M.ProjectMember(project_id=p.id, user_id=users[uname].id,
                                          role="PM" if uname == "Dana Okafor" else "Engineer",
                                          allocation_pct=25.0))
            for tname, subs in TASKS:
                t = M.Task(project_id=p.id, name=tname, is_billable=True)
                S.add(t); S.flush()
                for code, sname, bh, bf in subs:
                    S.add(M.Subtask(task_id=t.id, code=code, name=sname,
                                    budget_hours=float(bh), budget_fee=float(bf)))
        # overhead / G&A bucket
        oh = M.Project(name="Overhead / G&A", client_name="Internal", is_overhead=True,
                       is_billable=False, lifecycle_status="active", source="manual",
                       overall_budget_fee=0.0)
        S.add(oh); S.flush()
        oht = M.Task(project_id=oh.id, name="General & Administrative", is_billable=False)
        S.add(oht); S.flush()
        ohs = M.Subtask(task_id=oht.id, code="900", name="Admin / BD / PTO", budget_hours=0, budget_fee=0)
        S.add(ohs); S.flush()
        S.flush()

        # rate lookup
        rate = {u.id: S.query(M.UserRate).filter_by(user_id=u.id).first() for u in users.values()}

        # first subtask of each project (for time entries)
        def first_sub(proj):
            t = S.query(M.Task).filter_by(project_id=proj.id).first()
            return t, S.query(M.Subtask).filter_by(task_id=t.id).first()

        # ---- 8 weeks of timesheets + time entries -------------------------
        weeks = [monday_of(last_friday(TODAY)) - timedelta(weeks=w) for w in range(7, -1, -1)]
        # weekly hours split per person across the 4 billable projects (+ overhead)
        # (billable_per_project_list, overhead_hrs)
        LOAD = {
            "Dana Okafor":  ([6, 5, 4, 5], 12),
            "Marcus Reilly":([12, 10, 6, 8], 4),
            "Priya Nair":   ([14, 10, 8, 6], 2),
            "Tyler Brooks": ([16, 8, 4, 10], 2),
            "Sofia Mendes": ([10, 12, 6, 8], 4),
            "Grace Liu":    ([0, 0, 0, 0], 40),
        }
        for uname, u in users.items():
            r = rate[u.id]
            bills, ohh = LOAD[uname]
            for wk in weeks:
                fri = wk + timedelta(days=4)
                S.add(M.Timesheet(user_id=u.id, week_start=wk, week_end=fri, status="approved",
                                  employee_signed_at=datetime.combine(fri, datetime.min.time()),
                                  supervisor_signed_at=datetime.combine(fri, datetime.min.time()),
                                  approved_by_user_id=principal.id))
                for pi, hrs in enumerate(bills):
                    if hrs <= 0:
                        continue
                    proj = projects[pi]
                    t, sub = first_sub(proj)
                    # spread weekly hours across Mon/Wed/Fri
                    for dnum, frac in ((0, 0.4), (2, 0.35), (4, 0.25)):
                        h = round(hrs * frac, 1)
                        if h <= 0:
                            continue
                        S.add(M.TimeEntry(user_id=u.id, project_id=proj.id, task_id=t.id,
                                          subtask_id=sub.id, work_date=wk + timedelta(days=dnum),
                                          hours=h, note=sub.name, bill_rate_applied=r.bill_rate,
                                          cost_rate_applied=r.cost_rate, source="manual",
                                          is_billable=True, billed=(wk < weeks[-2])))
                if ohh > 0:
                    S.add(M.TimeEntry(user_id=u.id, project_id=oh.id, task_id=oht.id,
                                      subtask_id=ohs.id, work_date=wk, hours=float(ohh),
                                      note="G&A / Admin", bill_rate_applied=0.0,
                                      cost_rate_applied=r.cost_rate, source="manual",
                                      is_billable=False, billed=False))
        S.flush()

        # ---- invoices (revenue / AR) : per project, billed billable hours -
        inv_no = 2601
        for proj in projects:
            rows = (S.query(M.TimeEntry)
                    .filter(M.TimeEntry.project_id == proj.id, M.TimeEntry.is_billable == True)  # noqa: E712
                    .all())
            billed_rows = [te for te in rows if te.billed]
            amount = round(sum(te.hours * te.bill_rate_applied for te in billed_rows), 2)
            cost = round(sum(te.hours * te.cost_rate_applied for te in billed_rows), 2)
            if amount <= 0:
                continue
            issue = TODAY - timedelta(days=40)
            # split into two invoices: one paid, one open (AR).
            # Most billed work collected; a meaningful slice still open as receivables.
            for k, (frac, paid) in enumerate([(0.82, True), (0.18, False)]):
                amt = round(amount * frac, 2)
                inv = M.Invoice(invoice_number=f"PEC-{inv_no}", project_id=proj.id,
                                client_name=proj.client_name, source="manual",
                                start_date=issue - timedelta(days=30), end_date=issue,
                                issue_date=issue + timedelta(days=k * 21),
                                due_date=issue + timedelta(days=k * 21 + 30),
                                status="paid" if paid else "sent",
                                subtotal_amount=amt, amount_paid=amt if paid else 0.0,
                                balance_due=0.0 if paid else amt,
                                total_cost=round(cost * frac, 2),
                                total_profit=round((amt - cost * frac), 2),
                                paid_date=(issue + timedelta(days=k * 21 + 20)) if paid else None)
                S.add(inv); S.flush()
                S.add(M.InvoiceLine(invoice_id=inv.id, work_date=issue, project_id=proj.id,
                                    description=f"Professional services - {proj.name}",
                                    hours=round(sum(te.hours for te in billed_rows) * frac, 1),
                                    bill_rate=0.0, amount=amt))
                inv_no += 1
        S.flush()

        # ---- project expenses (COGS) --------------------------------------
        EXP = [
            ("Subconsultant - Geotechnical (BoreTech)", "Subconsultant", 8600),
            ("Subconsultant - Survey (Meridian Land)",  "Subconsultant", 5400),
            ("Bluebeam Revu licenses",                  "Software",      1180),
            ("AutoCAD Civil 3D subscription",           "Software",      2460),
            ("Reproduction / large-format plots",       "Reproduction",   540),
            ("Field travel & mileage",                  "Travel",         820),
            ("Permit application fees",                 "Permits",       1250),
        ]
        for i, (desc, cat, amt) in enumerate(EXP):
            proj = projects[i % len(projects)]
            S.add(M.ProjectExpense(project_id=proj.id, expense_date=TODAY - timedelta(days=15 + i * 3),
                                   category=cat, description=desc, amount=float(amt), source="manual"))
        # a couple of overhead expenses
        for desc, cat, amt in [("Office rent", "Rent", 3800), ("Business insurance (E&O)", "Insurance", 1450),
                               ("QuickBooks / software", "Software", 210)]:
            S.add(M.ProjectExpense(project_id=oh.id, expense_date=TODAY - timedelta(days=10),
                                   category=cat, description=desc, amount=float(amt), source="manual"))
        S.flush()

        # ---- bank feed (for the categorization / expense-tracking view) ---
        conn = M.BankConnection(provider="manual", user_id=principal.id,
                                institution_name="First Meridian Bank", status="connected",
                                item_id="demo-item-1")
        S.add(conn); S.flush()
        acct = M.BankAccount(connection_id=conn.id, account_id="demo-chk", name="Business Checking",
                             mask="4021", type="depository", subtype="checking", is_business=True,
                             current_balance=84210.55, available_balance=84210.55)
        S.add(acct); S.flush()
        txns = [
            ("BORETECH GEOTECHNICAL", "BoreTech Geotechnical", -8600.00, "Subconsultant"),
            ("MERIDIAN LAND SURVEY", "Meridian Land Survey", -5400.00, "Subconsultant"),
            ("BLUEBEAM INC", "Bluebeam", -1180.00, "Software"),
            ("AUTODESK SUBSCRIPTION", "Autodesk", -2460.00, "Software"),
            ("PROPERTY MGMT LLC RENT", "Office Rent", -3800.00, "Rent"),
            ("HUDSON COUNTY DOT ACH", "Hudson County DOT", 42350.00, "Client Payment"),
            ("CITY OF FAIRVIEW AP", "City of Fairview", 31900.00, "Client Payment"),
        ]
        for i, (name, merch, amt, cat) in enumerate(txns):
            S.add(M.BankTransaction(connection_id=conn.id, account_id="demo-chk",
                                    transaction_id=f"demo-tx-{i}", posted_date=TODAY - timedelta(days=8 + i),
                                    name=name, merchant_name=merch, amount=amt, is_business=True,
                                    category_json=json.dumps([cat]), source="manual"))
        S.flush()

        # ---- payroll: fictitious roster + recent PAID biweekly runs + YTD -
        # Timekeeping → payroll → COGS: several past-dated paid runs so the company
        # P&L shows real labor cost in the trailing window (drives net margin).
        from app.payroll.engine import compute_employee
        emp_by_user = {}
        for first, last, title, role, bill, cost, pay, fed, allow, k401 in PEOPLE:
            u = users[f"{first} {last}"]
            e = PM.PayrollEmployee(user_id=u.id, legal_name=f"{last}, {first}", work_state="NY",
                                   residence_state="NY", nyc_resident=False, pay_rate=float(pay),
                                   is_salary=False, k401_deferral_pct=float(k401), k401_er_match_pct=4.0,
                                   fed_filing_status=fed, state_allowances=allow,
                                   ny_marital="married" if fed == "mfj" else "single",
                                   nj_rate_table="A", is_active=True,
                                   hire_date=date(2024, 1, 15))
            S.add(e); S.flush()
            emp_by_user[u.id] = e
        S.flush()

        # Three consecutive bi-weekly PAID runs, check-dates 7 / 21 / 35 days ago —
        # sized so the trailing-window P&L shows a realistic (not inflated) net margin.
        N_RUNS = 3
        for k in range(N_RUNS):
            check_date = TODAY - timedelta(days=7 + 14 * k)
            pay_period_end = check_date - timedelta(days=5)
            pay_period_start = pay_period_end - timedelta(days=13)
            run = PM.PayrollRun(period_start=pay_period_start, period_end=pay_period_end,
                                check_date=check_date, weeks=2, status="paid",
                                created_by=principal.id, approved_by=principal.id,
                                approved_at=datetime.utcnow(), tax_year=2026)
            S.add(run); S.flush()
            for u in users.values():
                e = emp_by_user[u.id]
                hrs = (S.query(M.TimeEntry)
                       .filter(M.TimeEntry.user_id == u.id,
                               M.TimeEntry.work_date >= pay_period_start,
                               M.TimeEntry.work_date <= pay_period_end)
                       .all())
                total_h = round(sum(t.hours for t in hrs), 1) or 80.0
                g = Decimal(str(e.pay_rate)) * Decimal(str(total_h))
                ei = EmployeeInput(name=e.legal_name, gross=g,
                                   pretax_401k=cents(g * Decimal(str(e.k401_deferral_pct)) / 100),
                                   state="NY", nyc_resident=False, weeks=2,
                                   k401_er_match_pct=Decimal("4"),
                                   w4={"filing_status": e.fed_filing_status,
                                       "ny_marital": e.ny_marital, "ny_exemptions": e.state_allowances,
                                       "periods": 26})
                res = compute_employee(ei)
                S.add(PM.PayrollLine(run_id=run.id, employee_id=e.id, hours=total_h,
                                     gross=float(res.gross), pretax_401k=float(res.pretax_401k),
                                     lines_json=json.dumps({k2: float(v) for k2, v in res.lines.items() if v is not None}),
                                     net=float(res.net or 0)))
        # YTD ledger (pay-stub cumulative) — ~18 pay periods so far this year.
        for u in users.values():
            e = emp_by_user[u.id]
            g_year = Decimal(str(e.pay_rate)) * Decimal("80")  # ~1 period gross baseline
            S.add(PM.PayrollYtd(employee_id=e.id, tax_year=2026,
                                ytd_gross=round(float(g_year) * 18, 2), ytd_ss_wages=round(float(g_year) * 18, 2),
                                ytd_medicare=round(float(g_year) * 18, 2), ytd_futa_wages=round(float(g_year) * 18, 2),
                                ytd_ui_wages=round(float(g_year) * 18, 2)))
        S.commit()

        # ---- summary ------------------------------------------------------
        nu = S.query(M.User).count(); npj = S.query(M.Project).count()
        nte = S.query(M.TimeEntry).count(); ninv = S.query(M.Invoice).count()
        nexp = S.query(M.ProjectExpense).count(); npe = S.query(PM.PayrollEmployee).count()
        print(f"SEEDED demo DB at {os.environ['DATABASE_URL']}")
        print(f"  users={nu} projects={npj} time_entries={nte} invoices={ninv} expenses={nexp} payroll_employees={npe}")
        print(f"  admin login: dana.okafor@{DOMAIN}")
    finally:
        S.close()


if __name__ == "__main__":
    run()
