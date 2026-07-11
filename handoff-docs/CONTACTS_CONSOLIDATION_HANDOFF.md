# Handoff — Contacts consolidation + sync

**Repo:** `riddimrida22/aquatech-fb-lite-app` · **Branch merged to:** `main` (squash commit `89bf8fe`, PR #1)
**Date:** 2026-07-11

This session built the tooling to consolidate/dedupe contacts and to sync with iCloud.
Everything is **merged to `main`**. What remains needs a session with **more access than a
cloud sandbox has** — prod SSH, your Google/iCloud logins, and/or browser control.

---

## What's DONE (in `main`, tested — 35 backend tests pass)

1. **App BD-contact cleanup** — `backend/app/contacts_cleanup.py`, CLI `backend/dedupe_contacts.py`,
   endpoint `POST /contacts/cleanup?apply=`. Merges duplicates (email OR name+org, transitive),
   keeps the richest record, unions notes, removes empties, repoints pursuit/activity refs.
   Dry-run by default; idempotent.
2. **iCloud (CardDAV) sync** — `backend/app/icloud_contacts.py`. vCard 3.0 parse/serialize,
   live `ICloudCardDAVClient`, `pull_from_icloud` (imports then dedups) / `push_to_icloud`.
   Columns `contacts.icloud_uid` / `icloud_etag` + migration. Endpoints
   `GET /contacts/icloud/status`, `POST /contacts/icloud/pull`, `POST /contacts/icloud/push`
   (require `MANAGE_PROJECTS`; 400 when unconfigured). Settings: `APPLE_ID`,
   `APPLE_APP_PASSWORD`, `ICLOUD_CARDDAV_URL` (env only — never commit).
3. **Offline vCard file deduper** — `backend/dedupe_vcard.py`. Dedupes any exported `.vcf`
   (Google / iCloud / phone) and writes a cleaned `.vcf`. Never touches a live account.
4. Decisions recorded in `DECISIONS.md` as proposed **D-032** (dedup rules) and **D-033**
   (iCloud sync design).

---

## What's LEFT (needs full-permission session)

### A. Run the app-contact cleanup on PROD
The cloud sandbox can't reach the GCE prod server (firewalled from it AND from GitHub
Actions). From a machine that can SSH to prod:
```bash
# on the deploy machine, SSH into prod, then:
cd /opt/AquatechPM
git fetch origin && git reset --hard origin/main
ALLOW_SKIP_CADDY_ON_443_CONFLICT=true FORCE_TAKEOVER_443=true RUN_GATE=false \
  ./scripts/deploy_from_commit.sh origin/main .env.prod   # loads new code + DB migration
scripts/backup_postgres.sh                                # take a backup first
docker exec aquatechpm_backend_1 python dedupe_contacts.py          # PREVIEW
docker exec aquatechpm_backend_1 python dedupe_contacts.py --apply  # APPLY
```

### B. Turn on iCloud sync (optional)
1. Create an Apple **app-specific password** (appleid.apple.com → Sign-In & Security).
2. Put `APPLE_ID` + `APPLE_APP_PASSWORD` in `.env.prod`; confirm prod egress to
   `contacts.icloud.com` is allowed.
3. `GET /contacts/icloud/status` → dry idea; `POST /contacts/icloud/pull` (preview the counts)
   → then `POST /contacts/icloud/push`.
   ⚠️ The live CardDAV HTTP path is unit-tested via a fake but **never exercised against real
   iCloud** (sandbox blocked egress). Smoke-test with real creds; CardDAV discovery may need a
   fixup once you see a real response.

### C. Dedupe Google / iCloud / phone contacts (the personal address books)
The sandbox couldn't reach Google/iCloud or drive a local browser, so these were **not**
touched. In a full-permission session:
- Export the address book to a **`.vcf`** (Google Contacts → Export → vCard; iCloud.com →
  Contacts → Export vCard), then:
  ```bash
  python backend/dedupe_vcard.py contacts.vcf            # writes contacts.cleaned.vcf
  ```
  Re-import the cleaned file. (A session that can drive the browser could also do the export/
  import clicks, or use Google Contacts' built-in "Merge & fix".)

---

## Known environment limits hit this session (why the above is left)
- No SSH/deploy creds to prod; prod SSH + HTTPS blocked from the sandbox.
- Egress to `contacts.icloud.com` and Google blocked by network policy (403).
- No control of the user's local Chrome (separate cloud container); no browser bridge configured.
