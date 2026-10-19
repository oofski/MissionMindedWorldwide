# Mission Minded Worldwide — Connecting the clinic laptops (cloud sync)

The Mission Minded app works on its own on every laptop, with no internet. To
have several laptops share **one live queue** — a patient checked in at the
front desk appears at Vitals, Dental Triage and Check-out a few seconds later —
the laptops need a small sync server to meet at.

**Mission Minded does not run a shared server, and the app has none built in.**
Each clinic sets up its own, once, on a free Cloudflare account. Until an
administrator connects a laptop to it, nothing leaves that laptop.

It happens in three steps:

1. **Someone sets up the clinic's sync server, once** — about 10 minutes in a
   web browser ([Part A](#part-a--set-up-the-clinics-sync-server-once)).
2. **They give you its address and the clinic key** — or a single
   **connection code** copied from a laptop that is already connected.
3. **You enter them on every laptop** — in **Admin → Cloud**, or with **Join a
   clinic already set up** on the sign-in screen of a new laptop
   ([Part B](#part-b--connect-each-laptop)).

> **Every laptop must run the same version of the app.** Update them all
> together (the version is shown at the bottom of the sidebar). A laptop on an
> older version cannot show or keep what newer laptops record, and a connection
> code made by one version is refused by a different one.

---

## Part A — Set up the clinic's sync server (once)

You need a web browser and an email address. Nothing is installed. Cloudflare
moves its menus around from time to time; if a menu named below is not where
this says, use the dashboard's search box (type `D1` or `Workers`).

### 1. Make a free Cloudflare account
Go to **https://dash.cloudflare.com/sign-up**, create an account and sign in.

### 2. Create the database
1. In the left menu open **Storage & Databases → D1 SQL Database**.
2. Click **Create**, name it **`mmw`**, and click **Create**.
3. That is all — do not add tables. The server creates its own the first time
   it is used.

### 3. Create the server (a "Worker")
1. In the left menu open **Compute (Workers) → Workers & Pages**.
2. Click **Create**, choose to create a **Worker** (start from "Hello World"),
   name it **`mmw-sync`**, and click **Deploy**. This makes a placeholder.
3. Click **Edit code**.
4. Select **all** of the placeholder code and delete it.
5. Paste in the **entire** contents of the file **`cloud/worker.js`** from the
   app's source — on GitHub it is
   https://github.com/oofski/MissionMindedWorldwide/blob/HEAD/cloud/worker.js
   (use the **Raw** button, then select all and copy).
6. Click **Deploy**.

### 4. Connect the database to the server
1. On the Worker's page open **Settings → Bindings**.
2. **Add** a binding of type **D1 database**.
3. **Variable name:** `DB` — exactly that, in capitals.
4. **D1 database:** choose `mmw`.
5. Save, and **Deploy** if asked.

### 5. Set the clinic key
The clinic key is the one password every laptop uses to talk to this server.

1. Still under the Worker's **Settings**, open **Variables and Secrets**.
2. **Add** a variable of type **Secret**:
   - **Name:** `CLINIC_KEY`
   - **Value:** a long passphrase you make up — four or five unrelated words
     and a number is good. Capitals and spaces count.
3. Save, and **Deploy** if asked. Write the key down somewhere safe.

Without `CLINIC_KEY` the server refuses every laptop — it never runs open.

### 6. Copy the server address
The Worker's page shows its address. It looks like:

```
https://mmw-sync.<your-subdomain>.workers.dev
```

### 7. Check it is running
Open the address with `/health` added to the end, for example
`https://mmw-sync.<your-subdomain>.workers.dev/health`. You should see:

```json
{ "ok": true, "service": "mmw-sync", "version": "1.7.0", "seq": true, "time": "2026-10-19T14:02:11.512Z" }
```

That only proves the server is up — it does not look at the key or the
database. Connecting the first laptop (Part B) checks both. If the page shows
something else, see [Troubleshooting](#troubleshooting).

Give the **address** and the **clinic key** to whoever connects the laptops.

### Keeping the server up to date
When a new release of the app says the sync server changed, open the Worker's
**Edit code** again, replace everything with the new `cloud/worker.js`, and
**Deploy**. The database, the binding and the clinic key stay as they are.

### The same thing from the command line (optional)
For someone comfortable with a terminal and Node.js, the project's `cloud/`
folder is set up for Cloudflare's `wrangler` tool, with the same names:

```bash
cd cloud
npm install
npx wrangler login                 # opens a browser to sign in to Cloudflare
npx wrangler d1 create mmw         # prints a database_id
#   paste that id into cloud/wrangler.toml in place of REPLACE_WITH_YOUR_D1_ID
npx wrangler deploy                # deploys worker.js as "mmw-sync" and prints its address
npx wrangler secret put CLINIC_KEY # type the clinic key when asked
```

The server still creates its own tables on first use, so
`npm run migrate:remote` is not needed.

---

## Part B — Connect each laptop

Do this on **every** laptop the clinic uses, with the **same** address and the
**same** clinic key.

### On a laptop you can sign in to as an administrator
1. Sign in as an administrator and open **Cloud** (the Admin part of the
   sidebar). A laptop that is not connected yet lists these same three steps.
2. Either
   - paste a **Connection code** and press **Connect with code**, or
   - type the **Server address** and the **Clinic key** and press **Connect**.
3. The app checks the address answers and the key is accepted before it saves
   anything. When it is connected, the **Connection** card says **Online**.

### On a laptop that is new to the clinic
1. On the sign-in screen press **Join a clinic already set up**.
2. Paste the **connection code** — or type the clinic address and key.
3. Press **Connect and sync**. The laptop downloads the clinic — its events,
   staff accounts and patients — and then returns to the sign-in screen.
4. Sign in with your **own** account. Staff accounts (with their passwords)
   travel between laptops, so the account you use on one laptop works on all
   of them. If your clinic changed the administrator password, that password
   now works here too and the shipped `admin` / `admin` no longer does.

**Join a clinic** works from the sign-in screen only while that laptop still
has the shipped `admin` / `admin` login (or no account at all). Once a laptop
has its own administrator password, connect it from **Admin → Cloud** instead —
otherwise anyone at the sign-in screen could point it at a different server.

### The connection code
A laptop that is connected can give out a **connection code**: one piece of
text that holds the server address and the clinic key, so the next laptop is a
paste instead of two things to type.

On the connected laptop open **Admin → Cloud**, and under **Connect another
laptop** press **Show connection code**, then **Copy code**. It starts with
`MMW1-`.

> **The connection code is the clinic's password.** Anyone who has it can read
> and change every patient record the clinic syncs. Share it only with your own
> clinic's staff, in person or by private message — never in a public post, a
> group chat, or an email to anyone outside the clinic.

### Then
- **Pick the clinic event once.** Under **Events**, press **Set active** on
  the clinic's event on any one laptop; the other laptops switch to it on their
  next sync. New patients are filed under the active event.
- **Try it:** check in a test patient on one laptop; within a few seconds it is
  on another laptop's dashboard.
- **No internet for a while?** Keep working. Each laptop keeps everything
  locally and catches up by itself when the connection returns. If two laptops
  change the same record while apart, the later change is kept.

---

## Part C — The online pre-registration link

Patients can fill in the check-in questions on their own phone before the
clinic, from a link for that clinic event. The link lives on the clinic's own
sync server, so it needs:

1. **A connected laptop.** Under **Events**, the **Pre-reg link** button
   appears beside each event once the laptop is connected to the sync server.
   **Copy link** and share it (text message, email, a QR code on a flyer).
2. **The event to have reached the server.** An event created on a connected,
   online laptop gets there within seconds. Until it has, the link says it is
   not valid.
3. **The event to be open.** Finishing the clinic, or turning the event off,
   closes the link; patients then see that the clinic is closed.
4. **Internet on the patient's phone.** No key or account is needed — the
   link can only add a sign-up to that one event, never read any record. The
   form is in English with a switch to Spanish (or add `?lang=es` to the link).

Sign-ups wait on the server and reach each laptop at its next sync. They appear
under **Arrivals → Pre-registered online**, tagged **Pre-reg**, and the front
desk confirms each person's arrival when they walk in.

---

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| "The server answered, but refused the clinic key." | The key typed is not exactly the `CLINIC_KEY` on the server, or the secret was never saved | Retype it — capitals and spaces count. In Cloudflare check **Settings → Variables and Secrets** has `CLINIC_KEY`, and Deploy |
| "Could not reach mmw-sync…workers.dev. Check this laptop is online…" | No internet, or the address is mistyped | Check the wifi. Open the address with `/health` in this laptop's browser — if that fails too, it is the connection or the address |
| "…did not answer in time." | Very slow wifi, or a hotspot that wants you to sign in first | Open any website in the browser to clear the hotspot's sign-in page, then try again |
| "That address did not return a Mission Minded sync server." | The address points somewhere else, or the Worker still has Cloudflare's sample code | Copy the address from the Worker's page again; if `/health` does not show `mmw-sync`, redo Part A step 3 |
| "The server has no database connected." | The D1 binding is missing or not named `DB` | Part A step 4 — the variable name must be exactly `DB` — then Deploy |
| **Cloud** shows **Sync paused — running locally** | Someone pressed **Pause sync (no internet)** | Press **Resume sync**. The laptop sends and receives everything it missed |
| **Cloud** shows **Reconnecting…** and a reason | The connection dropped during the clinic | Keep working. It retries every few seconds and catches up when the connection is back |
| "That connection code was made by a different version of the app." | The two laptops run different versions | Update both to the same version, then copy the code again |
| "That connection code is incomplete or damaged." | Part of the code was lost while copying | Use **Copy code** on the connected laptop and paste the whole thing |
| "That is a server address, not a connection code." | The address was pasted in the code box | Type it in the address box, with the clinic key |
| Join: "This computer already has its own administrator password…" | The laptop's administrator password was changed, so Join is closed | Sign in as that administrator and connect under **Admin → Cloud** |
| Join: "Connected, but no staff accounts came down yet." | The first laptop has not sent its accounts to the server yet | Sign in on the first laptop and check its **Cloud** tab says **Online**, then join again |
| A laptop shows different patients from the others | It is on a different active event | Under **Events**, press **Set active** on the right event |
| The pre-registration link says it is not valid | The event has not reached the server yet | Make sure a laptop with the event is connected and **Online**, wait a minute, try again |

---

## What travels between laptops

- **Synced:** clinic events (including which one is active and its city list),
  staff accounts and their passwords, patients and their registration answers,
  vitals and routing, Dental Triage and treatment records, consents and
  signatures, X-ray images, exit surveys, supplies, and the kept totals of
  finished clinics.
- **Stays on each laptop:** the connection settings themselves (address, key,
  online or paused), the audit log, and the X-ray import folder setting.

**The sync server is a meeting point, not a backup.** A deletion — including
**Finish clinic** — made on one laptop reaches the server and every other
laptop. Keep making backups under **Backup & Export**.

## Security
- The clinic key is the only credential, and the connection code contains it.
  Treat both as passwords.
- Every request is over HTTPS. The server checks the key on every request and
  refuses everything if `CLINIC_KEY` is not set.
- Showing the connection code is recorded in the audit log of the laptop it
  was shown on.
- **Changing the key:** set a new `CLINIC_KEY` in Cloudflare and Deploy. Each
  laptop then stops syncing until an administrator types the new key under
  **Admin → Cloud** and presses **Save server**. Connection codes made before
  the change stop working.

## Cost
Cloudflare's free plan is enough for a small clinic, with one limit worth
knowing. At the time of writing the free plan allows **100,000 requests a day**
to a Worker (check Cloudflare's current pricing page). A laptop that is open
with sync on asks the server for news about every 4 seconds — about 900
requests an hour, or 9,000 over a 10-hour clinic day. About ten laptops through
a clinic day fit; a laptop left open overnight counts too, so close the app
(or press **Pause sync**) on laptops that are not in use. If the limit is
reached, Cloudflare refuses requests until the daily reset, the laptops carry
on offline and catch up afterwards. A large clinic can move the Worker to
Cloudflare's paid plan.
