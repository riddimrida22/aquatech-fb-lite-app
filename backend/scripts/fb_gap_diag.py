"""READ-ONLY diagnostic: compare FreshBooks time entries vs AqtPM project linkage.
Identifies FB projects whose time entries get skipped (skipped_no_project) and
whether recent entries exist in FB that the app is dropping. No DB mutation."""
from __future__ import annotations
from collections import defaultdict
from app.db import SessionLocal
from app.freshbooks import api_get, load_token
from app.models import Project


def get_items(resp, key):
    if isinstance(resp, dict):
        if isinstance(resp.get(key), list):
            return resp[key]
        r = resp.get("result")
        if isinstance(r, dict) and isinstance(r.get(key), list):
            return r[key]
    return []


def get_pages(resp):
    for src in (resp, resp.get("result") if isinstance(resp, dict) else None,
                resp.get("meta") if isinstance(resp, dict) else None):
        if isinstance(src, dict) and src.get("pages"):
            try:
                return int(src["pages"])
            except (TypeError, ValueError):
                pass
    return 1


def main():
    with SessionLocal() as db:
        tok = load_token(db)
        if not tok or not tok.business_id:
            print("NO TOKEN / business_id"); return
        bid = tok.business_id
        print("business_id:", bid)

        # AqtPM linked project external_ids
        linked = {}
        for p in db.scalars(__import__("sqlalchemy").select(Project)).all():
            if p.external_id:
                try:
                    linked[int(p.external_id)] = p.name
                except (TypeError, ValueError):
                    pass
        print("AqtPM linked FB project ids:", sorted(linked))

        # FB projects: id -> title
        fb_proj = {}
        page = 1
        while True:
            r = api_get(db, "/projects/business/%s/projects" % bid,
                        params={"page": page, "per_page": 100})
            items = get_items(r, "projects")
            for p in items:
                fb_proj[int(p["id"])] = (p.get("title") or "?", p.get("active"), p.get("complete"))
            if page >= get_pages(r) or not items:
                break
            page += 1
        print("FB projects returned by /projects:", len(fb_proj))

        # FB time entries: group by project_id
        by_proj = defaultdict(lambda: {"n": 0, "min": None, "max": None})
        page = 1
        total = 0
        overall_max = None
        while True:
            r = api_get(db, "/timetracking/business/%s/time_entries" % bid,
                        params={"page": page, "per_page": 100, "team": "true"})
            items = get_items(r, "time_entries")
            if not items:
                break
            for e in items:
                total += 1
                pid = e.get("project_id")
                d = (e.get("local_started_at") or e.get("started_at") or "")[:10]
                rec = by_proj[pid]
                rec["n"] += 1
                if d:
                    rec["min"] = d if rec["min"] is None else min(rec["min"], d)
                    rec["max"] = d if rec["max"] is None else max(rec["max"], d)
                    overall_max = d if overall_max is None else max(overall_max, d)
            if page >= get_pages(r):
                break
            page += 1
        print("FB time_entries total:", total, "| latest date in FB:", overall_max)

        print("\n=== UNMAPPED projects (time entries SKIPPED by the app) ===")
        skipped_total = 0
        for pid, rec in sorted(by_proj.items(), key=lambda x: -(x[1]["n"])):
            if pid not in linked:
                skipped_total += rec["n"]
                title = fb_proj.get(pid, ("<not in /projects list>", None, None))[0] if pid else "<None project_id>"
                flags = fb_proj.get(pid)
                fl = "" if not flags else "  active=%s complete=%s" % (flags[1], flags[2])
                print("  proj_id=%s  entries=%-4s  %s..%s  '%s'%s" % (
                    pid, rec["n"], rec["min"], rec["max"], title, fl))
        print("TOTAL skipped (unmapped) entries:", skipped_total)

        print("\n=== mapped projects (these DO sync) ===")
        for pid, rec in sorted(by_proj.items(), key=lambda x: -(x[1]["n"])):
            if pid in linked:
                print("  proj_id=%s  entries=%-4s  %s..%s  -> '%s'" % (
                    pid, rec["n"], rec["min"], rec["max"], linked[pid]))


if __name__ == "__main__":
    main()
