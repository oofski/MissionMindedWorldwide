# Mission Minded Worldwide — Connecting the clinic laptops (cloud sync)

The Mission Minded app works on its own on every laptop, with no internet. To
have several laptops share **one live queue** — a patient checked in at the
front desk appears at Vitals, Dental Triage and Check-out a few seconds later —
the laptops need a small sync server to meet at.

**Mission Minded does not run a shared server, and the app has none built in.**
Each clinic sets up its own, once, on a free Cloudflare account. Until an
administrator connects a laptop to it, nothing leaves that laptop.

> **No internet at the clinic?** The laptops can meet over a Wi-Fi router
> instead: one laptop hosts the same sync server, the others join it, and it
> works the same way. See [Clinic network (no internet)](#clinic-network-no-internet).
> **Admin → Cloud** offers both, at the top: **Internet server** or
> **Clinic network (no internet)**.

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
> older version cannot show or keep what newer laptops record. Laptops on
> versions before 0.0.16 have no connection-code box at all; if a code is
> refused as being from a different version, update both laptops to the same
> version. A laptop before 0.0.16 also merges staff accounts that share a
> username across two events into one account: update **every** laptop
> before you set somebody up for a second event under the same username.
> Until every laptop is updated, **delete accounts only on a laptop that is
> already on 0.0.16** — and on an older one never click **Delete** on your
> own row. On an older version, Delete sends the deletion to the other
> laptops even when it refuses it ("You cannot delete your own account.", the
> last administrator, or "FOREIGN KEY constraint failed"), and an updated
> laptop may carry it out: a staff member's always, an administrator's on a
> laptop she has never used. The account comes back once the older laptop is
> updated.

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
     and a number is good. Capitals and spaces count. Use **plain letters,
     numbers and spaces only**: a curly quote (’) or a long dash (–), which a
     phone or Mac puts in by itself, cannot be sent by the app, and it says
     so.
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

### Before you connect a laptop that has already been used
A laptop that was used on its own first — for example one you tried the app
out on — brings everything on it into the clinic when it connects:

1. **All the laptops share one account named `admin`.** If its password was
   changed on this laptop, that password replaces the `admin` password on
   **every** laptop once it connects — usually the password of the laptop
   connected last wins — and the `admin` password set on the other laptops
   stops working on those laptops too. So **give `admin` the same password on
   every laptop before connecting it** (under **Admin → Staff & roles**), or be
   ready to use this laptop's `admin` password everywhere afterwards. Other
   administrators — accounts with a username of their own — are separate
   accounts and keep their own passwords. But two staff accounts with the
   **same username for the same event** on two laptops become one account,
   with the password of the laptop connected last. (The same username for two
   *different* events is two accounts, each with its own password — that is
   how somebody is set up again for the next clinic.)
2. **Everything already on this laptop goes to every laptop** — test patients,
   test events and test accounts included — and it cannot be taken back: a
   record deleted afterwards is deleted on every laptop. To start clean, back
   the laptop up (**Backup & Export**), then erase it with **Backup & Export →
   Reset this computer**; it returns to first-run setup, and from there **Join
   a clinic already set up** connects it with nothing of its own.

   The event every laptop starts with, **Mission Minded Clinic**, is also one
   event on all of them, like `admin`. If it was renamed, re-dated, given a
   city list or **Set active** on this laptop, this laptop's copy — name,
   dates, city list and Set active together — replaces the clinic's on every
   laptop. Left untouched here, it changes nothing. Deleted here before this
   laptop was ever connected, it changes nothing either: the clinic's event
   arrives when it connects. So set the clinic's event up on one laptop only,
   or check it under **Events** once this laptop is connected.

   The same goes for a laptop that was connected to **another server** first
   — a test server, say. Pointing it at the clinic's server (or connecting it
   again after **Disconnect**) sends everything on it to that server too, and
   brings the clinic's records down. What it had sent to the old server stays
   on that server. Deletions it only heard about from the old server are not
   passed on, and neither is a deletion of the shared `admin` account or of
   **Mission Minded Clinic** made before the move, so a trial cannot delete
   the clinic's. This laptop's own deletion of `admin` still keeps the shipped
   `admin` / `admin` off it — a new laptop's untouched `admin` / `admin` is
   refused here, while the clinic's `admin` with its changed password still
   arrives — and so does a deletion of `admin` it heard about. Either one is
   sent once the server turns out to hold only the shipped `admin` / `admin`
   (as when it was deleted before this laptop was ever connected), so it is
   gone from every laptop: all it can take there is the password the sign-in
   screen prints. Connected again after **Disconnect** to the same server, a
   laptop passes on its deletions as if it had stayed connected. (Moving to
   or from the clinic network passes on every deletion — see [Clinic
   network](#clinic-network-no-internet).) On a laptop that is already
   connected, **Save server** with a different address asks first, naming the
   new server.

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
- **No internet for a while?** Keep working, and leave sync on. Each laptop
  keeps everything locally and catches up by itself when the connection
  returns. With sync left on, if two laptops change the same record while
  apart, the later change is kept.
- **Paused sync is different.** A laptop whose sync was paused (**Pause sync
  (no internet)**) dates its changes when it is resumed, so they win over
  changes other laptops made in the meantime, even later ones. Resume it as
  soon as the connection is back, and don't change the same patient on two
  laptops while one of them is paused.

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

## Clinic network (no internet)

For a clinic with no internet — a church hall, a school, a field site — the
laptops can share one live queue over a **Wi-Fi router alone**. One laptop
**hosts** the clinic's sync server: the same server as Part A
(`cloud/worker.js`), running inside the app instead of at Cloudflare. The
other laptops **join** it. Everything else is the same as with the internet
server: the same live queue, the same **Connection** card with **Sync now**,
the same connection code, and the same rules for deletions, pausing and
moving a laptop. Nothing leaves the clinic's own Wi-Fi, and there is no
Cloudflare account and nothing to pay.

One rule is wider here. Moving a laptop **to or from the clinic network** —
hosting it, joining it, handing it to another laptop, or bringing the day up
to the internet server — is the clinic's own records moving between its own
servers, so **every deletion on the laptop goes with it**, the ones other
laptops made included, not only its own (Part B). A patient deleted on any
laptop stays deleted after the move, even when a laptop that was asleep, or
the internet server, still has the record.

### What you need
- **Any Wi-Fi router.** A home router is fine. It does not need internet —
  it only needs power. Give its Wi-Fi a password (**WPA2** or **WPA3**, which
  the router's settings call *Security*); never run the clinic on an open
  Wi-Fi.
- **Every laptop on the same Wi-Fi** — the router's own network. Not a phone
  hotspot, and not a "guest" network: guest networks usually stop laptops
  reaching each other.
- **The same version of the app on every laptop** (see the note at the top).
- **One laptop to host** that stays on, plugged in and awake for the whole
  clinic day — the registration laptop is a good choice. On Windows, stop it
  sleeping while plugged in: Settings → System → Power → *When plugged in,
  put my device to sleep after* → Never.

### Windows on the host laptop
1. **Make the clinic's Wi-Fi a Private network:** Settings → Network &
   internet → Wi-Fi → the clinic's network → **Network profile type →
   Private network**. On a Public network Windows keeps other laptops out.
2. **Let Mission Minded through the firewall.** The first time the laptop
   hosts, Windows shows "**Windows Defender Firewall has blocked some features
   of this app**". Tick **Private networks**, then press **Allow access**. The
   installer cannot do this for you: it installs for one Windows user, not
   for the whole computer.
3. **Missed that message, or pressed Cancel?** On the host's **Admin → Cloud**
   press **Allow through the firewall**: Windows asks for permission, then
   lets Mission Minded in on Private networks only. Or by hand: Windows
   Security → Firewall & network protection → Allow an app through firewall →
   Change settings → tick **Private** beside Mission Minded → OK.

**On a Mac host**, if macOS asks whether "Mission Minded" may **accept
incoming network connections**, press **Allow** (if it was denied: System
Settings → Network → Firewall → Options).

The joining laptops need none of this — they only connect out to the host.
If one of them shows the same Windows message when it looks for hosts, tick
Private networks and allow it there too, or type the host's address instead.

### Host the clinic network
1. On the host laptop, sign in as an administrator and open **Admin → Cloud**.
2. At the top, choose **Clinic network (no internet)**.
3. Under **Host the clinic network on this laptop**, fill in the **Clinic
   network name** — the clinic's name and place is good; it is what the
   other laptops see in their list — and press **Host the clinic network**.
4. The card **This laptop hosts the clinic network** shows the address the
   other laptops reach it at (like `192.168.1.23:47800`), the laptops
   connected now, and its **Security fingerprint**.

The host makes its own clinic key (five groups of letters and numbers) and
its own security certificate, and keeps both. **Show connection code** shows
the code — and the key, for typing — only when asked. Like the internet
server's, **the connection code is the clinic's password**.

### Join it from every other laptop
On each other laptop, on the same Wi-Fi:

- **In Admin → Cloud**, choose **Clinic network (no internet)**. Under
  **Join a clinic network** the clinic networks found on this Wi-Fi are
  listed (**Look again** searches again). Press **Choose** beside the
  clinic's, type the **Clinic key** the host shows, and press **Join** — or
  paste the host's connection code and press **Join with code**.
- **On a new laptop's sign-in screen**, press **Join a clinic already set
  up**: the clinic networks heard on this Wi-Fi are listed there too.
  **Choose**, type the clinic key, **Connect and sync** — or paste the
  connection code.
- **Not listed?** Some routers stop laptops finding each other. Type the
  address the host shows in **Host address** (like `192.168.1.23:47800`),
  with the clinic key.
- **Listed twice under the same name?** Beacons prove nothing by
  themselves, so another device can copy the clinic's name. Choose either:
  the wrong one cannot show it holds the clinic key, and says so — then
  choose the other, or paste the connection code.

Before a laptop sends the clinic key, the host must prove it holds the same
key; from then on the laptop accepts only that host's certificate. So a
look-alike laptop on the Wi-Fi learns nothing, and a laptop that is not the
clinic's host is refused: "The laptop at … is not this clinic's host: its
security certificate does not match, so nothing was sent to it."

### Test the clinic network
On a joined laptop, **Admin → Cloud → Test the clinic network** says what is
wrong, in the same words the **Connection** card uses while it retries:

| It says | What to do |
|---|---|
| "No clinic network host answered at …" | The host is off or asleep, has stopped hosting, or is on another Wi-Fi. Check its Cloud tab says **Hosting**, and that both laptops show the same Wi-Fi name |
| "The host laptop is on this Wi-Fi, but its firewall is blocking the connection to …" | On the host: make the Wi-Fi a Private network and let Mission Minded through the firewall (above) |
| "A computer answered at …, but Mission Minded is not hosting there." | The app is closed on the host, or **Stop hosting** was pressed. Open it / host again |
| "The laptop at … is not this clinic's host: its security certificate does not match…" | Another device has that address — or the host's clinic network was erased and hosted again: join with its new connection code |
| "The host answered, but refused the clinic key." | Type the key exactly as the host's Cloud tab shows it, or paste a fresh connection code |
| "The laptop at … could not show it holds this clinic key, so the key was not sent to it." | Joining from the list or a typed address: check the key — or, if the clinic network is listed twice, choose the other one, or paste the connection code |
| "Something answered at …, but it is not a Mission Minded clinic network host." | Another program has the host's address or port now. Check the address on the host's Cloud tab |

### When the host laptop is off or asleep
The other laptops keep working on their own — check-in, vitals, treatment,
everything — and their **Connection** card says the host is not answering.
When it is back they catch up by themselves, both ways, as they do online
when the internet drops. Leave sync on (the paused-sync rule in
[Then](#then) applies here too).

The host hosts again by itself when Mission Minded opens on it — on the
clinic's Wi-Fi. If the router gives it a new address, or its port was taken,
the other laptops find it again by its beacon — nobody retypes anything.

Opened anywhere else — at a hotel, a café, on a phone's hotspot — it does
not announce the clinic network there. Its card says "**Not on the clinic
Wi-Fi: hosting paused**", and it hosts again by itself as soon as it is back
on the clinic's Wi-Fi (also when the app opened before the Wi-Fi had
connected). A new router at the clinic counts as another network: on the
host, press **Host here anyway** once, and it remembers that one too.

### Moving the host to another laptop
1. On the new host, **Host the clinic network**. It asks first, because the
   laptop moves from the old clinic network to its own: everything on it goes
   to the new host, deletions included.
2. On each other laptop, **Join a different clinic network** — choose the new
   host, or paste its connection code. Each asks first, then sends everything
   on it, so nothing is lost. These are the same moves as between internet
   servers (Part B).
3. **The old host joins the new host too**, the same way, last. It is the
   one laptop with everything the old clinic network held; joining brings
   that across, and **stops its hosting** (it says so when it asks). Only
   if the old host is not coming, press **Stop hosting** on it instead.

A host moved to any other server — the internet server, another clinic
network, or **Disconnect** — stops hosting as part of the move, so no laptop
goes on syncing with a host that no longer syncs with them.

**Stop hosting** keeps the clinic network's data on that laptop: hosting
again there carries on, with the same connection code. **Erase the clinic
network data** removes it, with its certificate and key; a clinic network
hosted there afterwards is a new one, which every laptop joins again with its
new code. **Reset this computer** erases it too.

### Internet and the clinic network
A laptop syncs one way at a time. Choosing the other one in **Admin → Cloud**
— **Internet server** or **Clinic network (no internet)** — asks first and
moves the laptop like changing servers: everything on it goes to the new
one, deletions included, and everything there comes down. A clinic can run
on the clinic network during the day and bring the day's records up to its
internet server afterwards: once every laptop's **Connection** card says it
synced, connect **one** of them — not the host, which would stop hosting — to
the internet server. It carries every laptop's records and deletions. The
next clinic day, it joins the clinic network again. To go back to the
internet server for good, move every laptop, the host last.

### What the clinic network does not do
- **Online pre-registration** is for patients on their own phones, on the
  internet. The clinic network does not serve it ("Online pre-registration is
  not available on the clinic network"): check those patients in at the front
  desk.
- **It is not a backup.** The host keeps the clinic network's copy of the
  records in its own file, which **Back up database (.db)** does not include.
  Keep making backups under **Backup & Export** on the laptops.

---

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| "The server answered, but refused the clinic key." | The key typed is not exactly the `CLINIC_KEY` on the server, or the secret was never saved | Retype it — capitals and spaces count. In Cloudflare check **Settings → Variables and Secrets** has `CLINIC_KEY`, and Deploy |
| "The clinic key has a character this app cannot send…" | The key has a curly quote (’), a long dash (–) or another character a phone or Mac put in by itself, and the app cannot send it | In Cloudflare, change `CLINIC_KEY` to plain letters, numbers and spaces, Deploy, and type the new key on every laptop |
| "Could not reach mmw-sync…workers.dev. Check this laptop is online…" | No internet, or the address is mistyped | Check the wifi. Open the address with `/health` in this laptop's browser — if that fails too, it is the connection or the address |
| "…did not answer in time." | Very slow wifi, or a hotspot that wants you to sign in first | Open any website in the browser to clear the hotspot's sign-in page, then try again |
| "That address did not return a Mission Minded sync server." | The address points somewhere else, or the Worker still has Cloudflare's sample code | Copy the address from the Worker's page again; if `/health` does not show `mmw-sync`, redo Part A step 3 |
| "The server has no database connected." | The D1 binding is missing or not named `DB` | Part A step 4 — the variable name must be exactly `DB` — then Deploy |
| **Cloud** shows **Sync paused — running locally** | Someone pressed **Pause sync (no internet)** | Press **Resume sync**. The laptop sends and receives everything it missed. What was changed on it while paused counts as changed at the moment you resume, so it replaces other laptops' changes to the same records made meanwhile — resume as soon as you can |
| **Cloud** shows **Reconnecting…** and a reason | The connection dropped during the clinic | Keep working. It retries every few seconds and catches up when the connection is back |
| "That connection code was made by a different version of the app." | The two laptops run different versions | Update both to the same version, then copy the code again |
| "That connection code is incomplete or damaged." | Part of the code was lost while copying | Use **Copy code** on the connected laptop and paste the whole thing |
| "That is a server address, not a connection code." | The address was pasted in the code box | Type it in the address box, with the clinic key |
| Join: "This computer already has its own administrator password…" | The laptop's administrator password was changed, so Join is closed | Sign in as that administrator and connect under **Admin → Cloud** |
| Join: "This computer is already connected to a clinic server, so there is nothing to join." | The laptop is connected already — often after a first **Connect and sync** that found no accounts, once they arrived by themselves | Sign in with your own account. To move the laptop to a different server, sign in as an administrator and use **Admin → Cloud** |
| Join: "Connected, but no staff accounts came down yet." | Nothing but the shipped `admin` / `admin` is on this laptop after the download: the first laptop has not sent its accounts to the server yet (it is not connected, or not online) | Sign in on the first laptop and check its **Cloud** tab says **Online**. This laptop stays connected and picks the accounts up by itself; press **Connect and sync** again a minute later. If the clinic really has no account but `admin` / `admin` yet, go back and sign in with that |
| "Use the https:// address Cloudflare gives you." | The address was typed with `http://` | Copy the address from the Worker's page — it starts with `https://` |
| "That connection code names a plain http:// server…" | The laptop the code came from was connected to an `http://` address | On that laptop, connect to the `https://` address under **Admin → Cloud**, then copy the code again |
| **Cloud** shows **Reconnecting…** with a reason that mentions a limit, and the pre-registration link says it is not valid | The free plan's daily allowance is used up (see [Cost](#cost)) | Keep working — the laptops catch up after the daily reset at 00:00 UTC. To stop it happening, move the Worker to Cloudflare's paid plan |
| A laptop shows different patients from the others | It is on a different active event | Under **Events**, press **Set active** on the right event |
| Clinic network: no host in the list | The laptops are on different Wi-Fi networks, a guest network, or the router stops them finding each other | Check every laptop shows the same Wi-Fi name; type the **Host address** the host shows instead. More in [Test the clinic network](#test-the-clinic-network) |
| Clinic network: "…its firewall is blocking the connection…" | Windows on the host keeps the others out | On the host: a Private network, and **Allow through the firewall** ([Windows on the host laptop](#windows-on-the-host-laptop)) |
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
  Backups leave the connection settings out: **Back up database (.db)** and
  **Export clinic ZIP** hold no server address or clinic key.

**The sync server is a meeting point, not a backup.** A deletion — including
**Finish clinic** — made on one laptop reaches the server and every other
laptop. Keep making backups under **Backup & Export**.

## Security
- The clinic key is the only credential, and the connection code contains it.
  Treat both as passwords.
- Use the `https://` address Cloudflare gives you. The app refuses a plain
  `http://` address, typed or inside a connection code, because it would send
  the clinic key unprotected (the one exception is this computer itself —
  `localhost` — for someone testing the server with `wrangler dev`).
- The server checks the key on every sync request, and refuses them all if
  `CLINIC_KEY` is not set. Only the server's front page, `/health` and the
  pre-registration link answer without it; `/health` says only that the server
  is running, and the link can only add a sign-up to its own clinic event.
- Showing the connection code is recorded in the audit log of the laptop it
  was shown on.
- **On the clinic network** the host's certificate is its own, so every
  laptop checks it by its fingerprint, carried in the connection code (or
  learned once the host has proved it holds the clinic key), and refuses any
  other before sending anything. The host makes the clinic key itself. Its
  announcements on the Wi-Fi carry its name and address, never the key. Use
  a Wi-Fi password on the router.
- Backups do not contain the clinic key. A database backup, or the ZIP made
  for a hard drive, is the clinic's records as **Disconnect** leaves them; a
  laptop put back from one is connected again under **Admin → Cloud**.
- **Changing the key:** set a new `CLINIC_KEY` in Cloudflare and Deploy. Each
  laptop then stops syncing until an administrator types the new key under
  **Admin → Cloud** and presses **Save server**. Connection codes made before
  the change stop working.

## Cost
Cloudflare's free plan is enough to **try the cloud out**. For real clinic
days with several laptops, plan on Cloudflare's paid plan, because of how this
version of the sync server reads its database.

At the time of writing (check Cloudflare's current pricing pages), the free
plan allows each day:

| Free allowance | What uses it |
|---|---|
| **5,000,000 rows read** from the D1 database | Every time a laptop asks the server for news — about every 4 seconds while it is open with sync on, some 900 times an hour — this version of the server reads **every row it holds**, even when nothing is new |
| **100,000 rows written** | Each record saved on any laptop is about ten rows written on the server (the record, its indexes and the delivery counter) |
| **100,000 requests** to the Worker | Each of those checks for news, and each send |

The server holds roughly five to ten rows for every patient seen, plus one for
each event and staff account, and they stay there — a deleted or finished
clinic's records are kept as deletion markers. So **rows read is the limit a
clinic reaches first**:

- **Trying it out** — a few test patients, a hundred rows or so: one laptop
  reads about 90,000 rows an hour, and the free allowance lasts over 50
  laptop-hours a day.
- **A real clinic** — say 400 patients, about 3,000 rows: one laptop reads
  about 2.7 million rows an hour, so the free allowance runs out after about
  two laptop-hours; with five laptops open, in under half an hour.

When an allowance is used up, Cloudflare refuses the server's database until
the daily reset at **00:00 UTC**. Until then sync stops (each laptop's **Cloud**
tab shows **Reconnecting…** and the reason), the laptops carry on offline and
catch up after the reset, and the pre-registration link says it is not valid.

**For clinic days, move the Worker to Cloudflare's Workers Paid plan** — at the
time of writing $5 a month for the account, including 25 billion rows read and
50 million rows written a month, far more than a clinic uses. Either way, close
the app (or press **Pause sync (no internet)**) on laptops that are not in use:
a laptop left open overnight keeps asking for news. Press **Resume sync** before
anyone works on a paused laptop again (see [Then](#then)).
