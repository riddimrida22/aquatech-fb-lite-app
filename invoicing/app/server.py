"""
Aquatech Invoicing — the screen.

Runs in two modes, same code:

  • LOCAL (Windows PC): Excel + G: drive present. Generates the package straight into
    the client folder, opens Explorer. `python app/server.py` -> http://127.0.0.1:8765
  • CLOUD (GCE Linux container, INVOICING_CLOUD=1): no G:, no Excel. Reads AqtPM
    Postgres directly, renders PDFs with LibreOffice, and returns the whole package as
    a downloadable ZIP so either admin can generate invoices from the web app.

The two modes differ only in a few Windows-only conveniences (Explorer open, browser
auto-launch) and in how the finished package is delivered (folder vs ZIP download).
"""
from __future__ import annotations
import datetime as dt, io, os, shutil, tempfile, threading, uuid, zipfile
from fastapi import FastAPI, Body, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
import config, packager, packager_bc
import data_source

# Cloud when explicitly flagged or whenever we're not on Windows (no G:, no Excel COM).
CLOUD = os.environ.get("INVOICING_CLOUD") == "1" or os.name != "nt"

app = FastAPI(title="Aquatech Invoicing")

# token -> {"path": <zip file>, "name": <download filename>} for CLOUD downloads
_DOWNLOADS: dict[str, dict] = {}
_DL_DIR = os.path.join(tempfile.gettempdir(), "aqtpm_invoicing_downloads")
os.makedirs(_DL_DIR, exist_ok=True)


def _is_month(project: str) -> bool:
    return config.PROJECTS[project].get("bill_period") == "month"


# Client name as it should read in public.invoices (books/AR), per project.
BOOKS_CLIENT = {
    "HDR_LTCP4": "HDR",
    "JBCON": "Brown and Caldwell",
    "STANTEC": "Stantec/Brown and Caldwell",
}


def _identity(request: "Request") -> tuple[str, str]:
    """(email, display_name) of the authenticated admin, injected by Caddy forward_auth
    (copy_headers X-Invoicing-User/Name from the backend /invoicing-authz check)."""
    email = (request.headers.get("X-Invoicing-User") or "").strip()
    name = (request.headers.get("X-Invoicing-Name") or "").strip() or email
    return email, name


def _official_lock(project: str, sel: str) -> dict | None:
    """Latest official generation for (project, period), or None. Never raises (the
    table may not exist yet on a fresh deploy) — degrade to 'no official'."""
    try:
        return data_source.official_for(project, sel)
    except Exception:
        return None


def _period_label(res: dict) -> str | None:
    try:
        end = dt.date.fromisoformat(res["period"][1])
        return end.strftime("%B %Y")
    except Exception:
        return None


def _stamp_draft_pdf(path: str) -> None:
    """Overlay a DRAFT watermark on every page: a big translucent diagonal 'DRAFT' plus
    a red top banner, so a draft can never be mistaken for the official invoice."""
    import fitz
    doc = fitz.open(path)
    try:
        for page in doc:
            r = page.rect
            pivot = fitz.Point(r.width / 2, r.height / 2)
            page.insert_textbox(r, "DRAFT", fontsize=90, fontname="helv",
                                color=(0.93, 0.66, 0.66), align=1,
                                morph=(pivot, fitz.Matrix(45)), overlay=True)
            top = fitz.Rect(r.x0, r.y0 + 3, r.x1, r.y0 + 20)
            page.insert_textbox(top, "DRAFT - NOT FOR SUBMISSION", fontsize=11,
                                fontname="helv", color=(0.75, 0.0, 0.0), align=1,
                                overlay=True)
        doc.save(path, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP)
    finally:
        doc.close()


def _watermark_drafts(outdir: str) -> None:
    """Stamp every PDF in the package as DRAFT and add ' DRAFT' to every deliverable's
    filename (PDFs + the xlsx) so it's unmistakable in the ZIP."""
    for name in list(os.listdir(outdir)):
        full = os.path.join(outdir, name)
        if not os.path.isfile(full) or name.startswith("_div_") or name.startswith("~$"):
            continue
        base, ext = os.path.splitext(name)
        low = ext.lower()
        if low == ".pdf":
            try:
                _stamp_draft_pdf(full)
            except Exception as e:
                print(f"[invoicing] draft stamp skipped for {name}: {e}", flush=True)
        elif low != ".xlsx":
            continue
        if "DRAFT" not in base.upper():
            try:
                os.rename(full, os.path.join(outdir, f"{base} DRAFT{ext}"))
            except OSError:
                pass


@app.get("/api/projects")
def api_projects():
    return [{"key": k, "label": v["label"], "prime": v["prime"], "out_root": v["out_root"],
             "billing": "month" if v.get("bill_period") == "month" else "period"}
            for k, v in config.PROJECTS.items()]


@app.get("/api/periods")
def api_periods(project: str):
    """Unified selector list. HDR -> billing periods; Stantec/JobCon -> calendar months.
    Each item: {id, label, invoiced, invoice_no}. `id` is what preview/generate send back."""
    if _is_month(project):
        return packager_bc.list_months(project)
    out = []
    for p in packager.list_periods(project):
        out.append({"id": str(p["period_number"]),
                    "label": f"Period {p['period_number']}: {p['begin']} → {p['end']}",
                    "invoiced": p["invoiced"], "invoice_no": p["invoice_no"]})
    return out


def _ym(sel: str) -> tuple[int, int]:
    y, m = sel.split("-")
    return int(y), int(m)


@app.post("/api/preview")
def api_preview(request: Request, body: dict = Body(...)):
    try:
        project, sel = body["project"], str(body["sel"])
        combine = bool(body.get("combine_subtasks"))
        if _is_month(project):
            y, m = _ym(sel)
            pv = packager_bc.preview(project, y, m, combine=combine)
        else:
            pv = packager.preview(project, int(sel))
        # Tell the UI whether this period already has an OFFICIAL invoice, so it can warn
        # and choose the right action (draft vs authorized correction).
        if CLOUD and isinstance(pv, dict):
            email, _name = _identity(request)
            off = _official_lock(project, sel)
            pv["already_official"] = bool(off)
            if off:
                pv["official_invoice_no"] = off.get("invoice_no")
                pv["official_by"] = off.get("generated_by")
                pv["official_by_name"] = off.get("generated_by_name")
                pv["official_at"] = off.get("generated_at")
                pv["can_reissue_final"] = bool(email) and email == off.get("generated_by")
        return pv
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


def _zip_dir(src_dir: str, zip_name: str) -> str:
    """Zip a package folder (flat, one entry per file) into _DL_DIR and return the path."""
    zpath = os.path.join(_DL_DIR, f"{uuid.uuid4().hex}.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(os.listdir(src_dir)):
            full = os.path.join(src_dir, name)
            if os.path.isfile(full) and not name.startswith("_div_") and not name.startswith("~$"):
                zf.write(full, arcname=name)
    return zpath


@app.post("/api/generate")
def api_generate(request: Request, body: dict = Body(...)):
    try:
        project, sel = body["project"], str(body["sel"])
        inv_date = body.get("invoice_date")
        inv_date = dt.date.fromisoformat(inv_date) if inv_date else dt.date.today()
        odc = float(body.get("this_odc") or 0.0)
        real = bool(body.get("save_to_real"))
        email, name = _identity(request)
        confirm_reissue = bool(body.get("confirm_reissue"))
        invoice_sent = bool(body.get("invoice_sent"))   # checkbox: record in the books

        # Official vs draft. First generation of a (project, period) is OFFICIAL and
        # advances the ledger. Once official, a second generation is a DRAFT (watermarked,
        # never touches the ledger) UNLESS the ORIGINAL author explicitly re-issues a
        # correction (confirm_reissue), which stays official and keeps the same number.
        mode = "official"
        official = _official_lock(project, sel) if CLOUD else None
        if official:
            if email and email == official.get("generated_by") and confirm_reissue:
                mode = "official"
            else:
                mode = "draft"

        # CLOUD: no G: drive — build into a fresh temp dir and hand back a ZIP. Drafts
        # never advance the ledger (save_to_real=False); official does. out_override keeps
        # every write off G:; the official ledger append lands on the persistent volume.
        override = None
        if CLOUD:
            override = tempfile.mkdtemp(prefix="aqtpm_pkg_", dir=_DL_DIR)
            real = (mode == "official")
        if _is_month(project):
            y, m = _ym(sel)
            res = packager_bc.build_package(project, y, m, invoice_date=inv_date,
                                            this_odc=odc, save_to_real=real,
                                            out_override=override, make_pdfs=True,
                                            combine=bool(body.get("combine_subtasks")))
        else:
            res = packager.build_package(project, int(sel), invoice_date=inv_date,
                                         this_odc=odc, save_to_real=real,
                                         out_override=override, make_pdfs=True)
        if CLOUD:
            res["mode"] = mode
            if official:
                res["prior_official_by"] = official.get("generated_by")
                res["prior_official_by_name"] = official.get("generated_by_name")
                res["prior_official_at"] = official.get("generated_at")
            if mode == "draft":
                _watermark_drafts(res["outdir"])
            folder = os.path.basename(res["outdir"].rstrip("/\\"))
            if mode == "draft":
                folder = f"{folder} (DRAFT)"
            zpath = _zip_dir(res["outdir"], folder)
            token = uuid.uuid4().hex
            _DOWNLOADS[token] = {"path": zpath, "name": f"{folder}.zip"}
            shutil.rmtree(res["outdir"], ignore_errors=True)  # keep only the zip
            res["download_url"] = f"api/download/{token}"
            res["download_name"] = f"{folder}.zip"
            # record the event (drives the other admin's activity banner + the lock)
            try:
                data_source.record_generation(
                    project_key=project, period_id=sel, period_label=_period_label(res),
                    invoice_no=res.get("invoice_no"), kind=mode,
                    generated_by=email, generated_by_name=name,
                    this_total=res.get("this_total"))
            except Exception as e:
                print(f"[invoicing] record_generation skipped: {e}", flush=True)
            # Record into public.invoices (books/AR) ONLY when the user checks "Invoice
            # sent" — the deliberate confirmation that it's issued to the client. Replaces
            # the old FreshBooks sync. Drafts never publish; a draft can't be "sent".
            if mode == "official" and invoice_sent:
                try:
                    cfg = config.PROJECTS[project]
                    res["published"] = data_source.publish_invoice(
                        invoice_number=res["invoice_no"],
                        project_id=cfg["aqtpm_project_id"],
                        client_name=BOOKS_CLIENT.get(project, cfg.get("prime", "")),
                        begin=res["period"][0], end=res["period"][1],
                        issue_date=inv_date.isoformat(),
                        due_days=int(cfg.get("fb_due_days", 30)),
                        subtotal=res.get("this_total"),
                        notes="Issued by AqtPM invoice generator")
                except Exception as e:
                    print(f"[invoicing] publish_invoice skipped: {e}", flush=True)
                # Flag the hours this invoice covers as billed, so the app's unbilled
                # views stop counting them (the FreshBooks sync used to do this).
                try:
                    cfg = config.PROJECTS[project]
                    res["billed_entries"] = data_source.mark_time_entries_billed(
                        project_id=cfg["aqtpm_project_id"],
                        begin=res["period"][0], end=res["period"][1])
                except Exception as e:
                    print(f"[invoicing] mark_time_entries_billed skipped: {e}", flush=True)
        return res
    except Exception as e:
        import traceback
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-1500:]},
                            status_code=400)


@app.get("/api/download/{token}")
def api_download(token: str):
    d = _DOWNLOADS.get(token)
    if not d or not os.path.exists(d["path"]):
        return JSONResponse({"error": "download expired"}, status_code=404)
    return FileResponse(d["path"], media_type="application/zip", filename=d["name"])


@app.post("/api/open-folder")
def api_open_folder(body: dict = Body(...)):
    # Windows-only convenience; the cloud UI downloads a ZIP instead.
    if CLOUD:
        return JSONResponse({"error": "not available on the server"}, status_code=400)
    path = body.get("path")
    if path and os.path.isdir(path):
        os.startfile(path)  # type: ignore[attr-defined]  # noqa: Windows Explorer
        return {"opened": path}
    return JSONResponse({"error": "folder not found"}, status_code=404)


@app.get("/api/activity")
def api_activity(request: Request):
    """Recent generation events (who generated what, official vs draft, when) for the
    in-app banner — so each admin sees the other's activity."""
    me, _n = _identity(request)
    return {"me": me, "events": data_source.recent_generations(15) if CLOUD else []}


@app.get("/health")
def health():
    return {"ok": True, "cloud": CLOUD}


@app.get("/", response_class=HTMLResponse)
def index():
    return HTML


HTML = r"""
<!doctype html><html><head><meta charset="utf-8"><title>Aquatech Invoicing</title>
<style>
 :root{--bg:#0f1720;--panel:#17222e;--line:#26343f;--ink:#e6edf3;--muted:#8aa0b0;
       --accent:#2E5E8C;--accent2:#3d7bbd;--good:#2f9e5f;--warn:#c9a227;}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif}
 header{background:linear-gradient(90deg,#12202e,#1a2c3d);padding:16px 22px;border-bottom:1px solid var(--line)}
 header h1{margin:0;font-size:17px;letter-spacing:.3px}
 header .sub{color:var(--muted);font-size:12px;margin-top:3px}
 .wrap{max-width:1000px;margin:22px auto;padding:0 18px;display:grid;gap:16px}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}
 .card h2{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted)}
 label{display:block;font-size:12px;color:var(--muted);margin:0 0 5px}
 select,input{width:100%;padding:9px 10px;background:#0e1922;border:1px solid var(--line);
   border-radius:7px;color:var(--ink);font-size:14px}
 .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
 .row3{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:14px}
 button{cursor:pointer;border:0;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;color:#fff}
 .btn{background:var(--accent2)} .btn:hover{background:#4a8ad0}
 .btn-go{background:var(--good)} .btn-go:hover{background:#37b06c}
 .btn-ghost{background:#26343f} .btn-ghost:hover{background:#31424f}
 .actions{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;align-items:center}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line)}
 th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase}
 td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
 .big{font-size:26px;font-weight:700}
 .pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600}
 .pill.done{background:rgba(47,158,95,.16);color:#5fd699}
 .pill.open{background:rgba(201,162,39,.16);color:#e2c463}
 .muted{color:var(--muted)} .hide{display:none}
 .kv{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;align-items:baseline}
 .kv .k{color:var(--muted);font-size:12px}
 .warnbox{background:rgba(201,162,39,.1);border:1px solid rgba(201,162,39,.35);color:#e2c463;
   padding:9px 12px;border-radius:8px;font-size:13px;margin-top:10px}
 .filelist{font-size:12px;color:var(--muted);max-height:190px;overflow:auto;margin-top:8px}
 .filelist div{padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)}
 .spin{display:inline-block;width:14px;height:14px;border:2px solid #ffffff55;border-top-color:#fff;
   border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px;margin-right:7px}
 @keyframes s{to{transform:rotate(360deg)}}
</style></head><body>
<header><h1>Aquatech Engineering · Invoicing</h1>
 <div class="sub">Generate NYCDEP cost-plus sub-consultant invoices + timesheet backup — from live AqtPM data</div></header>
<div class="wrap">
 <div class="card hide" id="activity">
  <h2>Recent activity</h2>
  <div id="activitybody" class="filelist" style="max-height:150px"></div>
 </div>
 <div class="card">
  <h2>1 · Select</h2>
  <div class="row3">
   <div><label>Project / Prime</label><select id="project"></select></div>
   <div><label>Billing period</label><select id="period"></select></div>
   <div><label>Invoice date</label><input id="invdate" type="date"></div>
  </div>
  <div class="row" style="margin-top:14px">
   <div><label>Other Direct Costs this invoice ($)</label><input id="odc" type="number" step="0.01" value="0"></div>
   <div style="display:flex;align-items:flex-end"><div id="periodinfo" class="muted" style="font-size:12px"></div></div>
  </div>
  <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:var(--ink)">
    <input type="checkbox" id="combinesub" style="width:auto;margin:0" onchange="doPreview()"> Combine multiple sub-tasks into one invoice (B&C months with &gt;1 task)
  </label>
  <div class="actions">
   <button class="btn" onclick="doPreview()"><span id="pvspin" class="spin hide"></span>Preview numbers</button>
   <span id="msg" class="muted"></span>
  </div>
 </div>

 <div class="card hide" id="pvcard">
  <h2>2 · Preview <span id="pvinv" class="pill open"></span></h2>
  <div class="row">
   <div>
     <table><thead><tr><th>Employee</th><th class="num">Hours</th></tr></thead>
      <tbody id="pvhours"></tbody></table>
   </div>
   <div class="kv" id="pvkv"></div>
  </div>
  <div class="big" id="pvtotal" style="margin-top:14px"></div>
  <div id="pvwarn" class="warnbox hide"></div>
  <label style="display:flex;align-items:center;gap:8px;margin:10px 0 2px;font-size:13px;color:var(--ink)">
    <input type="checkbox" id="invsent" style="width:auto;margin:0"> <b>Invoice sent</b> &mdash; record it in the books (AR). Leave unchecked to just generate the package.
  </label>
  <div id="genactions" class="actions"></div>
 </div>

 <div class="card hide" id="rescard">
  <h2>3 · Result</h2>
  <div id="resbody"></div>
 </div>
</div>
<script>
const $=id=>document.getElementById(id);
let PROJECTS=[], CURPV=null;
async function jget(u){const r=await fetch(u);return r.json();}
async function jpost(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json();}
function money(x){return '$'+Number(x).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}

async function init(){
  PROJECTS=await jget('api/projects');
  $('project').innerHTML=PROJECTS.map(p=>`<option value="${p.key}">${p.label}</option>`).join('');
  $('invdate').value=new Date().toISOString().slice(0,10);
  await loadPeriods();
  $('project').onchange=loadPeriods;
  $('period').onchange=showPeriodInfo;
}
let PERIODS=[];
async function loadPeriods(){
  PERIODS=await jget('api/periods?project='+$('project').value);
  $('period').innerHTML=PERIODS.map(p=>`<option value="${p.id}">${p.label}${p.invoiced?'  ✓ '+(p.invoice_no||'billed'):''}</option>`).join('');
  const open=PERIODS.find(p=>!p.invoiced); if(open)$('period').value=open.id;
  showPeriodInfo();
}
function showPeriodInfo(){
  const p=PERIODS.find(x=>String(x.id)==String($('period').value));
  $('periodinfo').textContent=p?(p.invoiced?('Already invoiced'+(p.invoice_no?' as '+p.invoice_no:'')):'Not yet invoiced'):'';
}
function fmtDate(iso){try{return new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch(e){return iso;}}
function renderGenActions(pv){
  const el=$('genactions'); const spin='<span id="gtspin" class="spin hide"></span>';
  if(!pv.already_official){
    el.innerHTML='<button class="btn-go" onclick="doGenerate(\'official\')">'+spin+'Generate invoice package</button>';
  } else if(pv.can_reissue_final){
    el.innerHTML='<button class="btn" onclick="doGenerate(\'draft\')">'+spin+'Generate DRAFT</button>'+
      '<button class="btn-go" onclick="doGenerate(\'reissue\')">Re-issue FINAL (correction)</button>';
  } else {
    el.innerHTML='<button class="btn-go" onclick="doGenerate(\'draft\')">'+spin+'Generate DRAFT</button>';
  }
}
async function doPreview(){
  $('msg').textContent='';$('pvspin').classList.remove('hide');
  const pv=await jpost('api/preview',{project:$('project').value,sel:$('period').value,
              combine_subtasks: !!($('combinesub') && $('combinesub').checked)});
  $('pvspin').classList.add('hide');
  if(pv.error){$('msg').textContent='⚠ '+pv.error;return;}
  CURPV=pv;
  $('pvcard').classList.remove('hide');
  $('pvinv').textContent=(pv.already_official?'official: ':'next: ')+(pv.official_invoice_no||pv.invoice_no);
  $('pvhours').innerHTML=Object.entries(pv.invoice_hours).map(([k,v])=>`<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('')||`<tr><td colspan=2 class="muted">${pv.note||'no hours'}</td></tr>`;
  $('pvkv').innerHTML=`
    <div class="k">Period</div><div>${pv.period[0]} → ${pv.period[1]}</div>
    ${pv.active_subtask?`<div class="k">Active sub-task</div><div>${pv.active_subtask}</div>`:''}
    <div class="k">Staff direct labor</div><div>${money(pv.staff_direct_labor)}</div>
    <div class="k">Principal direct labor</div><div>${money(pv.principal_direct_labor)}</div>
    <div class="k">Prior labor cumulative</div><div>${money(pv.prior_labor_cumulative)}</div>
    <div class="k">Timesheet backups</div><div>${pv.timesheet_count} weekly PDFs</div>`;
  $('pvtotal').textContent='This invoice: '+money(pv.this_labor);
  renderGenActions(pv);
  if(pv.already_official){
    const who=pv.official_by_name||pv.official_by||'someone';
    $('pvwarn').classList.remove('hide');
    $('pvwarn').innerHTML='⚠ <b>'+(pv.official_invoice_no||'')+'</b> was already generated as the OFFICIAL invoice by <b>'+who+'</b>'+(pv.official_at?' on '+fmtDate(pv.official_at):'')+'. '+(pv.can_reissue_final?'You generated it, so you can re-issue a correction (same number) — or generate a draft.':'A new generation will be a DRAFT; only '+who+' can re-issue the final.');
  } else $('pvwarn').classList.add('hide');
}
async function doGenerate(mode){
  if(mode==='reissue' && !confirm('Re-issue the FINAL invoice '+((CURPV&&CURPV.official_invoice_no)||'')+' with corrections?\\n\\nKeeps the same number and replaces the official version. The other admin will see this in the activity log.'))return;
  const sp=$('gtspin'); if(sp)sp.classList.remove('hide');
  const body={project:$('project').value,sel:$('period').value,invoice_date:$('invdate').value,
              this_odc:$('odc').value, confirm_reissue:(mode==='reissue'),
              invoice_sent: !!($('invsent') && $('invsent').checked),
              combine_subtasks: !!($('combinesub') && $('combinesub').checked)};
  const m=await jpost('api/generate',body);
  if(sp)sp.classList.add('hide');
  $('rescard').classList.remove('hide');
  if(m.error){$('resbody').innerHTML='<div class="warnbox">⚠ '+m.error+'</div><pre class="muted" style="white-space:pre-wrap;font-size:11px">'+(m.trace||'')+'</pre>';return;}
  const isDraft=m.mode==='draft';
  const fileLines=Object.entries(m.files).map(([k,v])=>`<div>📄 ${k}: ${String(v).split(/[\\\\/]/).pop()}</div>`).join('')
    +m.timesheets.map(t=>`<div>🗓 wk${t.week} ${t.employee} (ending ${t.week_ending})</div>`).join('');
  const dl=m.download_url?`<div class="actions"><a href="${m.download_url}" download="${m.download_name}"><button class="${isDraft?'btn':'btn-go'}">⬇ Download ${isDraft?'DRAFT':'package'} (ZIP)</button></a></div>`
                         :`<div class="actions"><button class="btn" onclick="openFolder('${(m.outdir||'').replace(/\\\\/g,'\\\\\\\\')}')">Open folder</button></div>`;
  const badge=isDraft?'<span class="pill open">DRAFT — not for submission</span>':'<span class="pill done">OFFICIAL</span>';
  const note=isDraft&&m.prior_official_by_name?`<div class="k">Official is</div><div>${m.invoice_no} by ${m.prior_official_by_name} — ledger not changed</div>`:'';
  const booksLine = m.published ? `<div class="k">Books</div><div><span class="pill done">recorded in AR as SENT (${m.published})</span></div>`
                   : (!isDraft ? `<div class="k">Books</div><div><span class="pill open">not recorded</span> — tick "Invoice sent" to add it to AR</div>` : '');
  $('resbody').innerHTML=`
   <div class="big">${money(m.this_total)} · ${m.invoice_no} ${badge}</div>
   <div class="kv" style="margin-top:10px">
     <div class="k">Files</div><div>${Object.keys(m.files).length} invoice files + ${m.timesheets.length} timesheets</div>
     ${note}
     ${booksLine}
   </div>
   <div class="filelist">${fileLines}</div>
   ${dl}`;
  loadPeriods(); loadActivity();
}
async function loadActivity(){
  try{
    const a=await jget('api/activity'); const evs=(a&&a.events)||[];
    if(!evs.length){$('activity').classList.add('hide');return;}
    $('activity').classList.remove('hide');
    $('activitybody').innerHTML=evs.map(e=>{
      const who=e.generated_by_name||e.generated_by||'someone';
      const mine=a.me&&e.generated_by===a.me;
      const k=e.kind==='official'?'<b style="color:#5fd699">OFFICIAL</b>':'<span style="color:#e2c463">draft</span>';
      return '<div>'+k+' · '+(e.invoice_no||'')+' '+(e.period_label||'')+' — '+(mine?'you':who)+' · '+fmtDate(e.generated_at)+'</div>';
    }).join('');
  }catch(e){}
}
async function openFolder(p){await jpost('api/open-folder',{path:p});}
init().then(loadActivity);
</script></body></html>
"""


def main():
    import uvicorn
    port = int(os.environ.get("PORT", "8765"))
    host = "0.0.0.0" if CLOUD else "127.0.0.1"
    if not CLOUD:
        import webbrowser
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
