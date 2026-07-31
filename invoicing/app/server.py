"""
Local Invoicing app — the screen.

Run on the Windows PC (has the G: drive + Excel). Pick a project + billing period,
preview the numbers pulled live from AqtPM, then generate the complete package
(invoice xlsx + Summary/Detail/delivery PDFs + pixel-perfect weekly timesheet PDFs)
and save it into the correct invoice folder.

  python app/server.py   ->  open http://127.0.0.1:8765
"""
from __future__ import annotations
import datetime as dt, os, subprocess, threading, webbrowser
from fastapi import FastAPI, Body
from fastapi.responses import HTMLResponse, JSONResponse
import config, packager, packager_bc

app = FastAPI(title="Aquatech Invoicing")


def _is_month(project: str) -> bool:
    return config.PROJECTS[project].get("bill_period") == "month"


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
def api_preview(body: dict = Body(...)):
    try:
        project, sel = body["project"], str(body["sel"])
        if _is_month(project):
            y, m = _ym(sel)
            return packager_bc.preview(project, y, m)
        return packager.preview(project, int(sel))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.post("/api/generate")
def api_generate(body: dict = Body(...)):
    try:
        project, sel = body["project"], str(body["sel"])
        inv_date = body.get("invoice_date")
        inv_date = dt.date.fromisoformat(inv_date) if inv_date else dt.date.today()
        odc = float(body.get("this_odc") or 0.0)
        real = bool(body.get("save_to_real"))
        if _is_month(project):
            y, m = _ym(sel)
            return packager_bc.build_package(project, y, m, invoice_date=inv_date,
                                             this_odc=odc, save_to_real=real, make_pdfs=True)
        return packager.build_package(project, int(sel), invoice_date=inv_date,
                                      this_odc=odc, save_to_real=real, make_pdfs=True)
    except Exception as e:
        import traceback
        return JSONResponse({"error": str(e), "trace": traceback.format_exc()[-1500:]},
                            status_code=400)


@app.post("/api/open-folder")
def api_open_folder(body: dict = Body(...)):
    path = body.get("path")
    if path and os.path.isdir(path):
        os.startfile(path)  # noqa: Windows Explorer
        return {"opened": path}
    return JSONResponse({"error": "folder not found"}, status_code=404)


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
  <div class="actions">
   <button class="btn-ghost" onclick="doGenerate(false)"><span id="gtspin" class="spin hide"></span>Generate to TEST folder</button>
   <button class="btn-go" onclick="doGenerate(true)">Generate &amp; SAVE to invoice folder</button>
  </div>
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
  PROJECTS=await jget('/api/projects');
  $('project').innerHTML=PROJECTS.map(p=>`<option value="${p.key}">${p.label}</option>`).join('');
  $('invdate').value=new Date().toISOString().slice(0,10);
  await loadPeriods();
  $('project').onchange=loadPeriods;
  $('period').onchange=showPeriodInfo;
}
let PERIODS=[];
async function loadPeriods(){
  const proj=PROJECTS.find(p=>p.key==$('project').value);
  document.querySelector('label[for=periodlabel]');
  PERIODS=await jget('/api/periods?project='+$('project').value);
  $('period').innerHTML=PERIODS.map(p=>`<option value="${p.id}">${p.label}${p.invoiced?'  ✓ '+(p.invoice_no||'billed'):''}</option>`).join('');
  // default to first not-yet-invoiced
  const open=PERIODS.find(p=>!p.invoiced); if(open)$('period').value=open.id;
  showPeriodInfo();
}
function showPeriodInfo(){
  const p=PERIODS.find(x=>String(x.id)==String($('period').value));
  $('periodinfo').textContent=p?(p.invoiced?('Already invoiced'+(p.invoice_no?' as '+p.invoice_no:'')):'Not yet invoiced'):'';
}
async function doPreview(){
  $('msg').textContent='';$('pvspin').classList.remove('hide');
  const pv=await jpost('/api/preview',{project:$('project').value,sel:$('period').value});
  $('pvspin').classList.add('hide');
  if(pv.error){$('msg').textContent='⚠ '+pv.error;return;}
  CURPV=pv;
  $('pvcard').classList.remove('hide');
  $('pvinv').textContent='next: '+pv.invoice_no;
  $('pvhours').innerHTML=Object.entries(pv.invoice_hours).map(([k,v])=>`<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('')||`<tr><td colspan=2 class="muted">${pv.note||'no hours'}</td></tr>`;
  $('pvkv').innerHTML=`
    <div class="k">Period</div><div>${pv.period[0]} → ${pv.period[1]}</div>
    ${pv.active_subtask?`<div class="k">Active sub-task</div><div>${pv.active_subtask}</div>`:''}
    <div class="k">Staff direct labor</div><div>${money(pv.staff_direct_labor)}</div>
    <div class="k">Principal direct labor</div><div>${money(pv.principal_direct_labor)}</div>
    <div class="k">Prior labor cumulative</div><div>${money(pv.prior_labor_cumulative)}</div>
    <div class="k">Timesheet backups</div><div>${pv.timesheet_count} weekly PDFs</div>`;
  $('pvtotal').textContent='This invoice: '+money(pv.this_labor);
  if(pv.already_invoiced){$('pvwarn').classList.remove('hide');
    $('pvwarn').textContent='⚠ This period is already in the ledger ('+pv.invoice_no+'). Generating will be blocked unless you remove it.';}
  else $('pvwarn').classList.add('hide');
}
async function doGenerate(real){
  if(real && !confirm('Save the complete package into the real invoice folder on G:?\\n\\n'+$('project').value+' · '+$('period').value+'\\nThis writes files and advances the invoice number.'))return;
  $('gtspin').classList.remove('hide');
  const body={project:$('project').value,sel:$('period').value,invoice_date:$('invdate').value,
              this_odc:$('odc').value,save_to_real:real};
  const m=await jpost('/api/generate',body);
  $('gtspin').classList.add('hide');
  $('rescard').classList.remove('hide');
  if(m.error){$('resbody').innerHTML='<div class="warnbox">⚠ '+m.error+'</div><pre class="muted" style="white-space:pre-wrap;font-size:11px">'+(m.trace||'')+'</pre>';return;}
  const fileLines=Object.entries(m.files).map(([k,v])=>`<div>📄 ${k}: ${v.split('\\\\').pop()}</div>`).join('')
    +m.timesheets.map(t=>`<div>🗓 wk${t.week} ${t.employee} (ending ${t.week_ending})</div>`).join('');
  $('resbody').innerHTML=`
   <div class="big">${money(m.this_total)} · ${m.invoice_no}</div>
   <div class="kv" style="margin-top:10px">
     <div class="k">Saved to</div><div>${m.saved_to_real?'<span class="pill done">REAL invoice folder</span>':'<span class="pill open">TEST folder</span>'}</div>
     <div class="k">Folder</div><div>${m.outdir}</div>
     <div class="k">Files</div><div>${Object.keys(m.files).length} invoice files + ${m.timesheets.length} timesheets</div>
   </div>
   <div class="filelist">${fileLines}</div>
   <div class="actions"><button class="btn" onclick="openFolder('${m.outdir.replace(/\\\\/g,'\\\\\\\\')}')">Open folder</button></div>`;
  loadPeriods();
}
async function openFolder(p){await jpost('/api/open-folder',{path:p});}
init();
</script></body></html>
"""


def main():
    import uvicorn
    port = 8765
    threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
