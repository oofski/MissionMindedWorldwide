import { el, clear, toast, modal } from '../dom.js';
import { t, languageList } from '../i18n.js';
import { api } from '../api.js';
import { readConnectionCode } from '../connectionCode.js';
import { store } from '../store.js';
import { icon } from '../icons.js';
import { eventCities } from '../components/intakeSections.js';

// Cloud-sync live-update subscription. Kept at module scope so repaints of the
// Cloud tab can drop the previous listener before adding a new one (no stacking).
let cloudUnsub = null;

// Each of these is reached from its own sidebar item (Staff & roles, Events,
// Languages, Cloud, Backup & Export, Audit log). renderAdmin(ctx, {section})
// renders JUST that section as a standalone page — no tab bar. Titles/subtitles
// for the standalone header:
const SECTION_META = {
  staff: ['Staff & roles', 'Add your team and control who can access each part of the app.'],
  events: ['Clinic events', 'Set up and switch the active clinic event.'],
  data: ['Backup & Export', 'Back up this device and export event data.'],
  languages: ['Languages', 'Choose which language packs appear at patient check-in.'],
  cloud: ['Cloud', 'Keep every station on one shared, live queue — over the internet, or over the clinic\'s own Wi-Fi.'],
  audit: ['Audit log', 'A record of who did what, and when.'],
};

export function renderAdmin(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  // The sidebar drives navigation now, so a section is always specified. Default
  // to staff if somehow called without one.
  let tab = params.section && SECTION_META[params.section] ? params.section : 'staff';
  // Cloud: which way of syncing the administrator is looking at ('internet' |
  // 'lan'), kept while this page repaints. Unset, it follows what this laptop
  // is connected to.
  let cloudChoice = null;

  const sectionFns = { staff: staffTab, events: eventsTab, data: dataTab, languages: langTab, cloud: cloudTab, audit: auditTab };

  function paint() {
    clear(root);
    const [title, sub] = SECTION_META[tab] || ['Admin', ''];
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('div', {
            style: 'font-size:var(--fs-2xs); text-transform:uppercase; letter-spacing:var(--tracking-eyebrow); color:var(--teal-deep); font-weight:var(--fw-semibold); margin-bottom:var(--space-1);',
          }, ['Mission Minded Worldwide']),
          el('h1', {}, [title]),
          el('p', { class: 'view-sub' }, [sub]),
        ]),
      ]),
      el('div', { class: 'tab-body', id: 'tab-body' }),
    );
    const body = root.querySelector('#tab-body');
    sectionFns[tab](body);
  }

  /* ---- Staff ---- */
  async function staffTab(body) {
    const [users, active] = await Promise.all([api.listUsers(), api.activeEvent()]);
    // Global administrators live outside any single event; everyone else is
    // scoped to the event they were created for.
    const globals = users.filter((u) => u.role === 'admin' || u.event_id == null);
    const eventStaff = active ? users.filter((u) => u.event_id === active.id && u.role !== 'admin') : [];

    clear(body);

    // --- Event-scoped staff card -------------------------------------------
    const staffCard = el('div', { class: 'card' });
    const headActions = el('div', { class: 'inline-row', style: 'margin:0' });
    headActions.append(
      el('button', {
        class: 'btn btn--primary btn--sm',
        disabled: !active,
        onClick: () => editUser(null, active),
      }, [icon('plus', { size: 15 }), 'Add staff']),
    );
    if (active && eventStaff.length) {
      headActions.append(
        el('button', {
          class: 'btn btn--danger btn--sm',
          onClick: () => startFresh(active, eventStaff.length),
        }, [icon('sparkle', { size: 14 }), 'Start fresh for next event']),
      );
    }

    staffCard.append(
      el('div', { class: 'card-head-row' }, [
        el('h3', { class: 'card-title' }, [icon('users', { size: 15 }), 'Clinic team']),
        headActions,
      ]),
      el('p', {
        class: 'view-sub',
        style: 'margin:0 0 var(--space-4);',
      }, active
        ? [
          'Staff for ',
          el('strong', { style: 'color:var(--text-strong);' }, [active.name]),
          '. These accounts are set up for this clinic only.',
        ]
        : ['No clinic event is active yet. Set one active under Events to add staff for it.']),
    );

    if (!active) {
      staffCard.append(
        el('div', {
          class: 'banner banner--locked',
          style: 'margin:0;',
        }, [icon('calendar', { size: 16 }), 'Activate a clinic event first, then come back to add your team.']),
      );
    } else if (!eventStaff.length) {
      staffCard.append(
        el('div', { class: 'data-table-wrap' }, [
          el('div', {
            class: 'empty',
            style: 'padding:var(--space-8) var(--space-4) !important;',
          }, ['No staff yet for this event. Use Add staff to invite your team.']),
        ]),
      );
    } else {
      staffCard.append(
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Name', 'Username', 'Role', 'Status', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, eventStaff.map((u) => staffRow(u, active))),
          ]),
        ]),
      );
    }
    body.append(staffCard);

    // --- Global administrators card ----------------------------------------
    const adminCard = el('div', { class: 'card' });
    adminCard.append(
      el('div', { class: 'card-head-row' }, [
        el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Global administrators']),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          onClick: () => editUser({ role: 'admin' }, active, true),
        }, [icon('plus', { size: 15 }), 'Add administrator']),
      ]),
      el('p', {
        class: 'view-sub',
        style: 'margin:0 0 var(--space-4);',
      }, ['Administrators work across every event and are never removed when you start fresh.']),
    );
    if (!globals.length) {
      adminCard.append(
        el('div', { class: 'data-table-wrap' }, [
          el('div', { class: 'empty' }, ['No administrators yet.']),
        ]),
      );
    } else {
      adminCard.append(
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Name', 'Username', 'Role', 'Scope', 'Status', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, globals.map((u) => staffRow(u, active, true))),
          ]),
        ]),
      );
    }
    body.append(adminCard);

    function staffRow(u, activeEvent, showScope) {
      const cells = [
        el('td', {}, [el('strong', {}, [u.full_name])]),
        el('td', {}, [u.username]),
        el('td', {}, [el('span', { class: 'pill pill--blue' }, [t(`roles.${u.role}`)])]),
      ];
      if (showScope) {
        const scoped = u.role !== 'admin' && u.event_id != null;
        cells.push(el('td', {}, [
          scoped
            ? el('span', { class: 'pill pill--neutral' }, [activeEvent && u.event_id === activeEvent.id ? activeEvent.name : 'Event'])
            : el('span', { class: 'pill pill--purple' }, [icon('globe', { size: 12 }), 'Global']),
        ]));
      }
      // Not on her own row: turning herself off ended her session at the next
      // click, with nobody signed in to turn her back on (main refuses it too).
      const own = !!store.user && store.user.id === u.id;
      cells.push(
        el('td', {}, [u.active
          ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Active'])
          : el('span', { class: 'pill pill--neutral' }, ['Disabled'])]),
        el('td', {}, [el('div', { class: 'inline-row', style: 'margin:0; justify-content:flex-end;' }, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => editUser(u, activeEvent) }, [icon('pen', { size: 14 }), 'Edit']),
          own ? null : el('button', {
            class: 'btn btn--ghost btn--sm',
            onClick: async () => {
              try { await api.updateUser({ id: u.id, active: !u.active }); paint(); } catch (e) { toast(e.message, 'error'); }
            },
          }, [u.active ? 'Disable' : 'Enable']),
          el('button', { class: 'btn btn--danger btn--sm', onClick: () => delUser(u) }, [icon('trash', { size: 14 })]),
        ])]),
      );
      return el('tr', {}, cells);
    }

    async function startFresh(activeEvent, count) {
      const ok = await modal({
        title: 'Start fresh for the next event?',
        body: `Remove all <b>${count}</b> clinical staff for <b>${activeEvent.name}</b>? Administrators are kept so you can set up the next clinic. This cannot be undone.`,
        confirmText: 'Remove staff',
        cancelText: 'Cancel',
        danger: true,
      });
      if (!ok) return;
      try {
        const r = await api.clearEventStaff(activeEvent.id);
        toast(`Removed ${r.deleted} staff member(s). Administrators are kept.`, 'success');
        paint();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function delUser(u) {
      const ok = await modal({ title: 'Delete staff account?', body: `Permanently delete <b>${u.full_name}</b> (${u.username})?`, confirmText: 'Delete', cancelText: 'Cancel', danger: true });
      if (!ok) return;
      try { await api.deleteUser(u.id); toast('Staff account deleted', 'success'); paint(); } catch (e) { toast(e.message, 'error'); }
    }
  }

  // The people Add staff can copy into the active event: staff accounts on
  // OTHER events, minus anyone whose username this event already has (a second
  // "ana" here would be refused). Each account is listed with its event, since
  // the same person may be on several.
  async function copyCandidates(active) {
    const [users, events] = await Promise.all([api.listUsers(), api.listEvents()]);
    const names = new Map(events.map((e) => [e.id, e.name]));
    const here = new Set(users.filter((x) => x.event_id === active.id).map((x) => x.username));
    return users
      .filter((x) => x.role !== 'admin' && x.event_id != null && x.event_id !== active.id && !here.has(x.username))
      .map((x) => ({ ...x, event_name: names.get(x.event_id) || 'a deleted event' }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name) || a.event_name.localeCompare(b.event_name));
  }

  // `forceAdmin` locks the role to admin (used by "Add administrator").
  async function editUser(u, active, forceAdmin) {
    const isNew = !u || !u.id;
    const name = el('input', { class: 'input', value: u && u.full_name ? u.full_name : '', placeholder: 'Full name' });
    const uname = el('input', { class: 'input', value: u && u.username ? u.username : '', placeholder: 'Username', disabled: !isNew });
    const role = el('select', { class: 'input select' });
    // v1.0.9: the Triage station is gone, so 'triage' is not offered for new
    // staff. It stays listed ONLY when editing an existing legacy triage
    // account, so saving that user never silently changes their role.
    const roleOpts = [['registration', t('roles.registration')], ['emt', t('roles.emt')], ['hygienist', t('roles.hygienist')], ['doctor', t('roles.doctor')], ['checkout', t('roles.checkout')], ['admin', t('roles.admin')]];
    if (u && u.role === 'triage') roleOpts.unshift(['triage', t('roles.triage')]);
    roleOpts.forEach(([v, l]) => {
      const op = el('option', { value: v }, [l]);
      if ((u && u.role === v) || (forceAdmin && v === 'admin')) op.selected = true;
      role.append(op);
    });
    if (forceAdmin) role.disabled = true;
    // Her own role neither: a changed role ends the session, and taking the
    // administrator role from herself left nobody to give it back.
    if (u && u.id && store.user && store.user.id === u.id) role.disabled = true;
    const pass = el('input', { class: 'input', type: 'password', placeholder: isNew ? 'Password' : 'New password (leave blank to keep)' });

    // A staff account belongs to one event, so somebody who worked another
    // clinic is set up again for this one — the same username is allowed on
    // each event (v0.0.16). Picking them here fills in their name, username
    // and role, and "Keep the same password" lets them sign in as they did
    // there. Only the account's id goes to main; the password itself never
    // comes to this screen. Typing someone in by hand works as it always has.
    const copyable = isNew && !forceAdmin && active ? await copyCandidates(active) : [];
    const copyFrom = el('select', { class: 'input select' }, [
      el('option', { value: '' }, ['No one — type a new person in below']),
      ...copyable.map((x) => el('option', { value: String(x.id) }, [`${x.full_name} — ${t(`roles.${x.role}`)} — ${x.event_name}${x.active ? '' : ' (turned off)'}`])),
    ]);
    const keepPw = el('input', { type: 'checkbox' });
    const keepText = el('span', {}, ['Keep the same password']);
    const keepRow = el('label', { class: 'form-check', style: 'display:none;' }, [keepPw, keepText]);
    const picked = () => copyable.find((x) => String(x.id) === copyFrom.value) || null;
    // A turned-off account's password is not kept (main refuses it too): the
    // account was turned off for a reason, and the new one would be working.
    const canKeep = () => !!picked() && picked().active;
    const keeping = () => canKeep() && keepPw.checked;
    const showPassword = () => {
      const p = picked();
      pass.disabled = keeping();
      if (keeping()) pass.value = '';
      pass.placeholder = keeping() ? `The password ${p.full_name} uses for ${p.event_name}` : 'Password';
    };
    copyFrom.addEventListener('change', () => {
      const p = picked();
      keepRow.style.display = canKeep() ? '' : 'none';
      if (!canKeep()) keepPw.checked = false;
      if (p) {
        name.value = p.full_name;
        uname.value = p.username;
        // The retired 'triage' role is not offered for new staff; the role is
        // then left for the administrator to choose.
        if (Array.from(role.options).some((o) => o.value === p.role)) role.value = p.role;
        keepText.textContent = `Keep the same password as for ${p.event_name}`;
      }
      showPassword();
    });
    keepPw.addEventListener('change', showPassword);
    // The kept password is that person's, for that username. Typing a different
    // username over theirs is somebody else — who must not get it (they could
    // then be signed in to by the person picked) — so the pick is let go.
    uname.addEventListener('input', () => {
      const p = picked();
      if (!p || uname.value.trim().toLowerCase() === p.username) return;
      copyFrom.value = '';
      keepPw.checked = false;
      keepRow.style.display = 'none';
      showPassword();
    });

    const fields = [
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Full name']), name]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Username']), uname]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Role']), role]),
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Password']), pass]),
    ];
    if (copyable.length) {
      fields.unshift(el('label', { class: 'field span-2' }, [
        el('span', { class: 'field-label' }, ['Copy someone from another event']),
        copyFrom,
        el('span', { class: 'field-hint' }, ['Optional. Fills in their name, username and role. They get a separate account for this event.']),
      ]));
      fields.push(el('div', { class: 'field span-2' }, [keepRow]));
    }
    // On a new event-scoped staff member, make the scope obvious.
    if (isNew && !forceAdmin && active) {
      fields.push(el('div', { class: 'field span-2' }, [
        el('div', { class: 'note-banner' }, [icon('calendar', { size: 15 }), `This account will be set up for ${active.name}.`]),
      ]));
    }
    const form = el('div', { class: 'form-grid' }, fields);

    const ok = await modal({ title: isNew ? 'Add staff member' : 'Edit staff', body: form, confirmText: 'Save', cancelText: 'Cancel' });
    if (!ok) return;
    try {
      const p = picked();
      const kept = keeping();
      if (isNew) {
        // Omit event_id: the backend scopes non-admins to the active event and
        // keeps admins global automatically.
        await api.createUser({
          username: uname.value.trim(), full_name: name.value.trim(), role: role.value,
          ...(kept ? { copy_password_from: p.id } : { password: pass.value }),
        });
      } else {
        await api.updateUser({ id: u.id, full_name: name.value.trim(), role: role.value, password: pass.value || undefined });
      }
      toast(kept ? `Saved — ${name.value.trim()} signs in with the same password as for ${p.event_name}.` : 'Saved', 'success'); paint();
      // A password change here may have retired the shipped admin/admin, which
      // the standing warning is watching for.
      if (ctx.refreshSecurity) ctx.refreshSecurity();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---- Events ---- */
  async function eventsTab(body) {
    const events = await api.listEvents();
    const active = await api.activeEvent();
    const rows = events.map((e) => {
      const isActive = active && active.id === e.id;
      const actions = el('div', { class: 'inline-row', style: 'margin:0; justify-content:flex-end;' });
      if (e.active && !isActive) actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => setActive(e) }, ['Set active']));
      if (e.prereg_url) actions.append(el('button', { class: 'btn btn--ghost btn--sm', title: 'Patient pre-registration link', onClick: () => preregLink(e) }, [icon('globe', { size: 14 }), 'Pre-reg link']));
      actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => editEvent(e) }, [icon('pen', { size: 14 }), 'Edit']));
      // Close a clinic: keep the figures for reporting, remove the patients.
      actions.append(el('button', {
        class: 'btn btn--soft btn--sm',
        title: 'Keep the reporting totals, remove every patient record',
        onClick: async () => {
          const ok = await modal({
            title: `Finish “${e.name}”?`,
            body: 'The clinic’s <b>reporting totals are kept</b> — patients seen, procedures, and the breakdowns by age, gender, language and city — so this event still appears in Reports and grant returns.<br><br>Every <b>patient record is permanently removed</b> from this computer, the clinic cloud, and every other station. Export the clinic first if you want to be able to restore it.<br><br>This cannot be undone.',
            confirmText: 'Finish clinic & remove patient data',
            cancelText: 'Cancel',
            danger: true,
          });
          if (!ok) return;
          try {
            const r = await api.finishEvent(e.id);
            toast(`“${e.name}” finished — report kept, ${r.removed} patient record(s) removed.`, 'success');
            paint();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, [icon('checkCircle', { size: 14 }), 'Finish clinic']));
      if (e.active) actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => setState(e, false) }, ['Turn off']));
      else actions.append(el('button', { class: 'btn btn--ghost btn--sm', onClick: () => setState(e, true) }, ['Reactivate']));
      actions.append(el('button', { class: 'btn btn--danger btn--sm', onClick: () => delEvent(e) }, [icon('trash', { size: 14 })]));
      return el('tr', { class: isActive ? 'row--active' : '' }, [
        el('td', {}, [el('strong', {}, [e.name]),
          isActive ? el('span', { class: 'pill pill--success', style: 'margin-left:6px' }, [el('span', { class: 'pill-dot' }), 'Active'])
            : (!e.active ? el('span', { class: 'pill pill--neutral', style: 'margin-left:6px' }, ['Off']) : null)]),
        el('td', {}, [e.location || '—']),
        el('td', {}, [e.start_date || '—']),
        el('td', { class: 'num' }, [String(e.patient_count)]),
        el('td', {}, [actions]),
      ]);
    });
    clear(body);
    body.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-head-row' }, [
          el('h3', { class: 'card-title' }, [icon('calendar', { size: 15 }), 'Clinic events']),
          el('button', { class: 'btn btn--primary btn--sm', onClick: () => newEvent() }, [icon('plus', { size: 15 }), 'New event']),
        ]),
        el('p', { class: 'view-sub', style: 'margin:0 0 var(--space-4);' }, ['Each event has its own team, patients, and language packs. Set one active to make it the current clinic.']),
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Event', 'Location', 'Start', 'Patients', ''].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, rows),
          ]),
        ]),
      ]),
    );

    async function setActive(e) {
      try { const ev = await api.setActiveEvent(e.id); store.setEvent(ev); toast('Active event set', 'success'); paint(); } catch (err) { toast(err.message, 'error'); }
    }
    // Share the per-event pre-registration link. Patients open it ahead of time,
    // answer the check-in questions, and appear in THIS event's queue.
    async function preregLink(e) {
      const input = el('input', { class: 'input', readonly: true, value: e.prereg_url, style: 'font-family:var(--font-mono);font-size:var(--fs-sm)' });
      const copyBtn = el('button', { class: 'btn btn--primary', type: 'button' }, [icon('save', { size: 14 }), 'Copy link']);
      copyBtn.addEventListener('click', async () => {
        try { input.select(); if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(e.prereg_url); else document.execCommand('copy'); toast('Link copied', 'success'); }
        catch (_) { input.select(); document.execCommand('copy'); toast('Link copied', 'success'); }
      });
      await modal({
        title: `Pre-registration link — ${e.name}`,
        body: el('div', {}, [
          el('p', { class: 'subtle small', style: 'margin:0 0 10px' }, ['Share this link with patients (text, email, flyer QR). Anyone who fills it out is added to this event’s check-in queue with a “Pre-reg” tag. The link is unique to this event.']),
          el('div', { class: 'inline-row', style: 'gap:8px' }, [input, copyBtn]),
          el('p', { class: 'subtle', style: 'font-size:var(--fs-2xs);margin:12px 0 0' }, ['Note: pre-registration needs the clinic to be Online (Admin → Cloud). Submissions arrive on the next sync.']),
        ]),
        confirmText: 'Done',
      });
    }
    async function setState(e, on) {
      try { await api.setEventState(e.id, on); store.setEvent(await api.activeEvent()); toast(on ? 'Event reactivated' : 'Event turned off', 'success'); paint(); } catch (err) { toast(err.message, 'error'); }
    }
    async function delEvent(e) {
      // Its staff accounts are deleted with it (each belongs to this one event),
      // on every laptop, as Start fresh deletes them. Administrators stay.
      const staffNote = e.staff_count ? ` Its <b>${e.staff_count}</b> staff account(s) are deleted with it; administrators are kept.` : '';
      const ok = await modal({ title: 'Delete event?', body: `Delete <b>${e.name}</b>?${e.patient_count ? ` It has <b>${e.patient_count}</b> patient record(s).` : ''}${staffNote}`, confirmText: 'Delete', cancelText: 'Cancel', danger: true });
      if (!ok) return;
      try {
        await api.deleteEvent(e.id, false);
        toast('Event deleted', 'success'); store.setEvent(await api.activeEvent()); paint();
      } catch (err) {
        // Has patients — offer a forced cascade delete.
        const force = await modal({ title: 'Permanently delete with patients?', body: `${err.message}<br><br>This will permanently delete the event <b>and all ${e.patient_count} patient record(s)</b>.${staffNote} This cannot be undone.`, confirmText: 'Delete everything', cancelText: 'Cancel', danger: true });
        if (!force) return;
        try { await api.deleteEvent(e.id, true); toast('Event and patients deleted', 'success'); store.setEvent(await api.activeEvent()); paint(); } catch (e2) { toast(e2.message, 'error'); }
      }
    }
  }

  function eventForm(e = {}) {
    const name = el('input', { class: 'input', placeholder: 'e.g. Belize Mission — March 2026', value: e.name || '' });
    const loc = el('input', { class: 'input', placeholder: 'Location', value: e.location || '' });
    const start = el('input', { class: 'input', type: 'date', value: e.start_date || '' });
    const enabled = new Set((e.languages || 'en,es').split(',').map((s) => s.trim()).filter(Boolean));
    const langChips = el('div', { class: 'chip-row' }, languageList().map((l) =>
      el('button', { type: 'button', class: 'chip-btn' + (enabled.has(l.code) ? ' chip-btn--on' : ''),
        onClick: (ev) => { if (enabled.has(l.code)) enabled.delete(l.code); else enabled.add(l.code); ev.currentTarget.classList.toggle('chip-btn--on'); } },
        [`${l.native}`])));
    // The towns offered in the check-in City dropdown, at the kiosk and on the
    // online form alike. Patients from anywhere else choose Other and type it.
    // Left empty, City stays a free-text box — nothing changes until an admin
    // sets a list.
    const cities = el('textarea', { class: 'input textarea', rows: 4, placeholder: 'Sandy\nBoring\nEstacada' }, [eventCities(e).join('\n')]);
    const form = el('div', { class: 'form-grid' }, [
      el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Event name']), name]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Location']), loc]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Start date']), start]),
      el('div', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Language packs offered at check-in']), langChips]),
      el('label', { class: 'field span-2' }, [
        el('span', { class: 'field-label' }, ['Cities offered at check-in (one per line)']),
        cities,
        el('span', { class: 'field-hint' }, ['Leave empty to let patients type their city. "Other" is always offered.']),
      ]),
    ]);
    return {
      form,
      get: () => ({
        name: name.value.trim(), location: loc.value.trim(), start_date: start.value, languages: Array.from(enabled).join(',') || 'en',
        cities: cities.value.split(/\r?\n/).map((c) => c.trim()).filter(Boolean),
      }),
    };
  }

  async function newEvent() {
    const f = eventForm();
    const ok = await modal({ title: 'Create clinic event', body: f.form, confirmText: 'Create', cancelText: 'Cancel' });
    if (!ok) return;
    try {
      const data = f.get();
      if (!data.name) { toast('Event name is required.', 'error'); return; }
      await api.createEvent(data);
      toast('Event created. Use “Set active” to make it the current event.', 'success'); paint();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function editEvent(e) {
    const f = eventForm(e);
    const ok = await modal({ title: 'Edit event', body: f.form, confirmText: 'Save', cancelText: 'Cancel' });
    if (!ok) return;
    try { await api.updateEvent({ id: e.id, ...f.get() }); store.setEvent(await api.activeEvent()); toast('Event updated', 'success'); paint(); } catch (err) { toast(err.message, 'error'); }
  }

  /* ---- Data / backup ---- */
  async function dataTab(body) {
    const incomplete = await api.listIncomplete().catch(() => []);
    const cst = await api.cloudStatus().catch(() => null);
    clear(body);

    // Describes what is actually true right now rather than a fixed claim.
    const cloudConnItem = (cst && cst.configured)
      ? connItem('Clinic cloud', `Sharing one live queue with ${(() => { try { return new URL(cst.url).host; } catch (_) { return cst.url; } })()}.`, 'blue')
      : connItem('Local only', 'No sync server. Records stay on this computer.', 'green');
    if (incomplete.length) {
      body.append(el('div', { class: 'card card--alert' }, [
        el('div', { class: 'card-title' }, [icon('alert', { size: 15 }), 'Incomplete records']),
        el('p', { class: 'muted', style: 'margin:0 0 var(--space-3);' }, [`${incomplete.length} patient record(s) have no intake data — these were created on an older app version (before the intake fix) and are safe to remove.`]),
        el('div', { class: 'data-table-wrap', style: 'margin-bottom:var(--space-3)' }, [
          el('table', { class: 'data-table data-table--mini' }, [
            el('thead', {}, [el('tr', {}, ['Created', 'Event', 'Name'].map((h) => el('th', {}, [h])))]),
            el('tbody', {}, incomplete.slice(0, 50).map((r) => el('tr', {}, [
              el('td', {}, [new Date(r.created_at).toLocaleDateString()]),
              el('td', {}, [r.event_name]),
              el('td', { class: 'muted' }, [`${(r.first_name || '').trim()} ${(r.last_name || '').trim()}`.trim() || '(no name)']),
            ]))),
          ]),
        ]),
        el('button', { class: 'btn btn--danger', onClick: async () => {
          const ok = await modal({ title: 'Delete incomplete records?', body: `Permanently delete all ${incomplete.length} empty record(s)? This cannot be undone.`, confirmText: 'Delete all', cancelText: 'Cancel', danger: true });
          if (!ok) return;
          try { const r = await api.cleanupIncomplete(); toast(`Deleted ${r.deleted} incomplete record(s)`, 'success'); paint(); } catch (e) { toast(e.message, 'error'); }
        } }, [icon('trash', { size: 16 }), `Delete all ${incomplete.length} empty record(s)`]),
      ]));
    }
    // End-of-clinic: take the data with you as a spreadsheet, then take it off
    // the machines. The purge is deliberately gated behind a fresh export.
    let exported = null;
    const purgeBtn = el('button', {
      class: 'btn btn--danger', disabled: true,
      title: 'Export first — this cannot be undone',
      onClick: async () => {
        const ok = await modal({
          title: 'Remove this clinic’s patient data?',
          body: `This permanently deletes <b>every patient record for the current clinic</b> from this computer, from the clinic cloud, and from every other station when it next syncs.<br><br>You exported <b>${exported && exported.patients} patient record(s)</b> to:<br><code>${exported && exported.xlsxPath}</code><br><br>Keep that file safe — restoring later is only possible from the <b>.chbak.json</b> saved beside it. This cannot be undone.`,
          confirmText: 'Delete the patient data',
          cancelText: 'Cancel',
          danger: true,
        });
        if (!ok) return;
        purgeBtn.disabled = true;
        try {
          const r = await api.purgeEvent();
          toast(`${r.removed} patient record(s) removed from this computer and the cloud.`, 'success');
          exported = null; paint();
        } catch (e) { toast(e.message, 'error'); purgeBtn.disabled = false; }
      },
    }, [icon('trash', { size: 16 }), 'Delete this clinic’s patient data']);
    const exportHint = el('p', { class: 'muted small', style: 'margin:var(--space-2) 0 0' }, [
      'Export first — the delete button unlocks once you have saved a copy.',
    ]);

    body.append(
      el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, [icon('download', { size: 15 }), 'End of clinic — take the data with you']),
        el('p', { class: 'muted', style: 'margin:0 0 var(--space-4);' }, [
          'Saves two files side by side: an ',
          el('strong', {}, ['Excel workbook']),
          ' you can read and share, and a ',
          el('strong', {}, ['.chbak.json backup']),
          ' that can put the whole clinic back later — including signed consents and x-ray images, which a spreadsheet cannot hold.',
        ]),
        el('div', { class: 'action-row', style: 'margin-top:0;' }, [
          el('button', { class: 'btn btn--primary', onClick: async (e) => {
            const btn = e.currentTarget; const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Exporting…';
            try {
              const r = await api.exportClinic();
              if (r.saved) {
                exported = r;
                purgeBtn.disabled = false;
                purgeBtn.title = 'Permanently delete this clinic’s patient data';
                exportHint.textContent = `Saved ${r.patients} patient record(s). Workbook: ${r.xlsxPath} · Backup: ${r.backupPath}`;
                toast(`Exported ${r.patients} patient record(s).`, 'success');
              }
            } catch (err) { toast(err.message, 'error'); }
            finally { btn.disabled = false; btn.textContent = prev; }
          } }, [icon('download', { size: 16 }), 'Export clinic (Excel + backup)']),
          el('button', { class: 'btn btn--ghost', onClick: async () => {
            try {
              const r = await api.importClinic();
              if (r.imported) { toast(`Restored ${r.patients} patient record(s) (${r.updated} updated).`, 'success'); paint(); }
            } catch (e) { toast(e.message, 'error'); }
          } }, [icon('refresh', { size: 16 }), 'Restore a clinic from backup']),
          // Recovery for a clinic whose figures were lost: recount from a backup
          // WITHOUT bringing any patient records back onto this computer.
          el('button', { class: 'btn btn--ghost', title: 'Recount an old clinic’s figures from its backup file, without restoring any patient records', onClick: async () => {
            try {
              const r = await api.rebuildReport();
              if (r.rebuilt) {
                toast(`Report rebuilt for “${r.event_name}” — ${r.summary.patients_seen} patient(s) recounted. No patient records were restored.`, 'success');
                paint();
              }
            } catch (e) { toast(e.message, 'error'); }
          } }, [icon('reports', { size: 16 }), 'Rebuild a report from backup']),
          purgeBtn,
        ]),
        exportHint,
      ]),
      el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, [icon('database', { size: 15 }), 'Backup & export']),
        el('p', { class: 'muted', style: 'margin:0 0 var(--space-4);' }, ['All data lives only on this device. Back up regularly to a USB drive or encrypted external drive, especially after each event.']),
        el('div', { class: 'action-row', style: 'margin-top:0;' }, [
          // End-of-clinic offload: one .zip with the whole database + records to
          // drop onto a hard drive.
          el('button', { class: 'btn btn--primary', onClick: async (e) => {
            const btn = e.currentTarget; const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Building ZIP…';
            try { const r = await api.exportZip(); if (r.saved) toast(`Clinic exported (${r.count} patient record(s)) to ${r.path}`, 'success'); }
            catch (err) { toast(err.message, 'error'); }
            finally { btn.disabled = false; btn.textContent = prev; }
          } }, [icon('download', { size: 16 }), 'Export clinic ZIP (for a hard drive)']),
          el('button', { class: 'btn btn--ghost', onClick: async () => {
            try { const r = await api.backup(); if (r.saved) toast(`Database backed up to ${r.path}`, 'success'); } catch (e) { toast(e.message, 'error'); }
          } }, [icon('database', { size: 16 }), 'Back up database (.db)']),
          el('button', { class: 'btn btn--ghost', onClick: async () => {
            try { const r = await api.exportEvent(); if (r.saved) toast(`Exported ${r.count} record(s) to ${r.path}`, 'success'); } catch (e) { toast(e.message, 'error'); }
          } }, [icon('download', { size: 16 }), 'Export event records (.json)']),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Connectivity']),
        el('div', { class: 'conn-grid' }, [
          connItem('Fully offline', 'All core features work with zero internet.', 'green'),
          connItem('USB export', 'Post-event backup & archiving to USB / encrypted drive.', 'blue'),
          connItem('Local network print', 'Print to a wireless laser printer on the same network.', 'teal'),
          // Reflects the ACTUAL connection state. A fixed claim here has been
          // wrong in both directions before — first "no cloud, data never leaves
          // this device" while sync was always-on, then "stations share one live
          // queue" while the server belonged to another organisation.
          cloudConnItem,
        ]),
      ]),

      /* ---- Reset this computer ----
         The blunt instrument, kept last and behind a typed confirmation. It is
         what an administrator needs when a machine holds records that are not
         this clinic's — which is exactly the state every v0.0.x install was left
         in by the inherited sync server. */
      el('div', { class: 'card card--alert' }, [
        el('div', { class: 'card-title' }, [icon('alert', { size: 15 }), 'Reset this computer']),
        el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
          'Permanently erases every patient record, staff account, event and audit entry on this computer, disconnects any sync server, and returns the app to first-run setup. Export anything you need first — this cannot be undone.',
        ]),
        el('div', { class: 'action-row' }, [
          el('button', {
            class: 'btn btn--danger',
            onClick: async () => {
              const field = el('input', { class: 'input', placeholder: 'RESET' });
              const ok = await modal({
                title: 'Erase everything on this computer?',
                body: el('div', {}, [
                  el('p', { style: 'margin:0 0 var(--space-3);' }, [
                    'This deletes every patient record, staff account, event and audit entry stored here, and returns the app to first-run setup. It cannot be undone.',
                  ]),
                  el('label', { class: 'field' }, [
                    el('span', { class: 'field-label' }, ['Type RESET to confirm']),
                    field,
                  ]),
                ]),
                confirmText: 'Erase everything', cancelText: 'Cancel', danger: true,
              });
              if (!ok) return;
              if (field.value.trim().toUpperCase() !== 'RESET') { toast('Not reset — the confirmation did not match.', 'info'); return; }
              try {
                await api.resetAllData();
                toast('This computer has been reset.', 'success');
                // Every account is gone, so the only valid destination is setup.
                ctx.navigate('setup');
              } catch (e) { toast(e.message, 'error'); }
            },
          }, [icon('alert', { size: 16 }), 'Erase everything and start over']),
        ]),
      ]),
    );
  }
  function connItem(title, desc, color) {
    return el('div', { class: `conn-item conn-item--${color}` }, [el('strong', {}, [title]), el('span', {}, [desc])]);
  }

  /* ---- Languages ---- */
  async function langTab(body) {
    const active = await api.activeEvent();
    const enabled = new Set((active && active.languages ? active.languages : 'en,es').split(',').map((s) => s.trim()));
    clear(body);
    body.append(el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Language packs']),
      el('p', { class: 'muted', style: 'margin:0 0 var(--space-4);' }, ['English, Spanish, Belizean Kriol, and Nyanja are built in. Choose which packs appear at check-in per event under Events, then Edit. Patient intake and consents are translated; Kriol and Nyanja are community-reviewable.']),
      el('div', { class: 'lang-pack-grid' }, languageList().map((l) =>
        el('div', { class: 'lang-pack' }, [
          el('div', {}, [el('strong', {}, [l.native]), el('span', { class: 'muted small' }, [` ${l.label} (${l.code})`])]),
          enabled.has(l.code)
            ? el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'On for active event'])
            : el('span', { class: 'pill pill--neutral' }, ['Available']),
        ]))),
    ]));
  }

  /* ---- Cloud sync ----
     Off and unconfigured unless this clinic deploys its own sync server and an
     administrator enters its address and key. Earlier builds shipped a server
     and key baked in and connected at boot with no user action, which is how
     this app ended up exchanging patient records with another organisation's
     clinic. There is no built-in server now, and none is implied here.

     v0.0.16: asked "how do I connect to online?", this screen answered with the
     path of a file in the source tree. It now says what to do, in the order it
     happens — the server is set up once, then every laptop is given its address
     and key, or one connection code — and a connected laptop hands that code
     out, so the second laptop is a paste rather than two things to retype.

     v0.0.17: two ways to sync, chosen at the top — the Internet server, exactly
     as before, or the Clinic network, for a clinic with a Wi-Fi router and no
     internet: one laptop hosts the same sync server, the others join it. One
     at a time: choosing the other one moves this laptop, asked first, as Save
     server asks. The Connection card (status, Sync now, pause) is the same in
     both. */
  async function cloudTab(body) {
    clear(body);

    // Deliberately no onCloudChanged subscription: an auto-repaint would wipe
    // the address/key an administrator is part-way through typing.
    if (cloudUnsub) { try { cloudUnsub(); } catch (_) { /* ignore */ } cloudUnsub = null; }

    // The step-by-step server guide, on the same public repository the app
    // takes its updates from (package.json build.publish). HEAD is whatever
    // branch that repository publishes from, so the link survives a rename.
    const SETUP_GUIDE_URL = 'https://github.com/oofski/MissionMindedWorldwide/blob/HEAD/docs/CLOUD_SETUP.md';

    let st;
    try {
      st = await api.cloudStatus();
    } catch (e) {
      body.append(el('div', { class: 'card' }, [
        el('h3', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Cloud sync']),
        el('p', { class: 'muted', style: 'margin:0;' }, [`Could not load cloud status: ${e.message}`]),
      ]));
      return;
    }

    // What this laptop syncs with now: '' (nothing), 'internet' or 'lan'. A
    // status from before v0.0.17 has no kind, and was an internet server.
    const kind = st.configured ? (st.kind === 'lan' ? 'lan' : 'internet') : '';
    const choice = cloudChoice || kind || 'internet';

    // The origin main saves for an address (cloud.js trimUrl): https:// added
    // when no scheme was typed, and any path dropped.
    const originOf = (u) => {
      let s = String(u || '').trim();
      if (!s) return '';
      if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
      try { return new URL(s).origin; } catch (_) { return s.replace(/\/+$/, ''); }
    };
    const hostOf = (u) => { try { return new URL(originOf(u)).host; } catch (_) { return String(u || ''); } };
    const netLabel = (name) => `the clinic network “${name || 'Clinic network'}”`;
    // How the server this laptop is on is named in a question.
    const whereNow = () => (kind === 'lan' ? netLabel(st.lanName) : hostOf(st.url));

    /* ---------- Internet server or clinic network ---------- */
    const seg = (value, label) => el('button', {
      type: 'button', class: 'seg-btn' + (choice === value ? ' seg-btn--on' : ''),
      onClick: () => { cloudChoice = value; paint(); },
    }, [label]);
    body.append(el('div', { class: 'card cloud-choice' }, [
      el('div', { class: 'card-title' }, [icon('globe', { size: 15 }), 'How this laptop syncs']),
      el('div', { class: 'seg-toggle' }, [seg('internet', 'Internet server'), seg('lan', 'Clinic network (no internet)')]),
      el('p', { class: 'muted small', style: 'margin:var(--space-3) 0 0;' }, [choice === 'internet'
        ? 'The laptops meet at the clinic\'s own sync server on the internet. Every laptop needs internet to sync.'
        : 'One laptop hosts, and the others join it over the clinic\'s Wi-Fi router. No internet is needed — only every laptop on the same Wi-Fi.']),
      kind && kind !== choice ? el('p', { class: 'subtle small cloud-choice-note', style: 'margin:var(--space-2) 0 0;' }, [kind === 'lan'
        ? 'This laptop syncs over the clinic network now. Connecting it to an internet server here moves it there, and it stops syncing with the clinic network.'
        : 'This laptop syncs with an internet server now. Hosting or joining a clinic network here moves it there, and it stops syncing with the internet server.']) : null,
    ]));

    // Said here because this is the laptop it applies to: one that was used
    // on its own first, like the ones a clinic tests with.
    const usedBanner = () => el('div', { class: 'banner banner--warn', style: 'margin:0 0 var(--space-3);' }, [
      icon('alert', { size: 14 }),
      el('span', {}, [
        el('strong', {}, ['Already used this laptop?']),
        ' Once it connects, everything on it — test patients included — goes to every laptop of the clinic. And the laptops share one account named admin: if its password was changed on this laptop, that password replaces the admin password on every laptop. Give admin the same password on each laptop before connecting, or, to start clean, back up and then erase this laptop (Backup & Export → Reset this computer).',
      ]),
    ]);

    // Moving this laptop to another server — another internet server, or
    // between the internet and the clinic network — asked the same way.
    const askMove = (to, verb) => modal({
      title: 'Move this laptop to a different server?',
      body: el('div', {}, [
        el('p', { style: 'margin:0 0 var(--space-3);' }, [
          `This laptop is connected to ${whereNow()}. ${verb} ${to} sends every record on this laptop to ${to} — patients, staff accounts and events, the ones from ${whereNow()} included — and they stay there.`,
        ]),
        el('p', { style: 'margin:0;' }, [
          'If this laptop is going to a different clinic, cancel, back it up, and erase it with Backup & Export → Reset this computer before connecting it.',
        ]),
      ]),
      confirmText: `Send everything to ${to}`, cancelText: 'Cancel', danger: true,
    });

    // Joining a clinic network, however the host arrives — picked from the
    // list found, typed, or read from a pasted code. Tested first (the host
    // proves it has the key before this laptop sends it, unless a code
    // brought the pin), then saved with the pin the test returns.
    async function joinLan(url, key, lanT, btn) {
      if (!url) { toast('Pick the host laptop from the list, or type its address.', 'error'); return; }
      if (!key) { toast('Enter the clinic key shown on the host laptop\'s Cloud tab, or paste its connection code.', 'error'); return; }
      btn.disabled = true;
      try {
        const r = await api.cloudTest(url, key, lanT || {});
        const target = (r && r.lan) || {};
        if (st.configured && !(kind === 'lan' && target.pin === st.lanPin)) {
          if (!(await askMove(netLabel(target.name), 'Joining'))) return;
        }
        await api.cloudConfig({ url: (r && r.url) || url, key, online: true, lan: target });
        cloudChoice = 'lan';
        toast('Joined the clinic network.', 'success');
        paint();
      } catch (e) { toast(e.message, 'error'); }
      finally { btn.disabled = false; }
    }

    /* ---------- The Connection card: the same in both ways ---------- */
    function connectionCard() {
      const host = hostOf(st.url);
      const pill = !st.online
        ? el('span', { class: 'pill pill--neutral' }, ['Sync paused — running locally'])
        : st.lastError
          ? el('span', { class: 'pill pill--amber' }, [icon('alert', { size: 12 }), 'Reconnecting…'])
          : el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Online']);

      const toggle = el('button', {
        class: 'btn btn--ghost',
        onClick: async () => {
          try { await api.cloudConfig({ online: !st.online }); paint(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }, [icon('refresh', { size: 16 }), st.online ? (kind === 'lan' ? 'Pause sync' : 'Pause sync (no internet)') : 'Resume sync']);

      const syncNowBtn = el('button', {
        class: 'btn btn--ghost', disabled: !st.online,
        onClick: async () => {
          try {
            const r = await api.cloudSyncNow();
            if (r && r.ok) toast(`Synced — pushed ${r.pushed}, pulled ${r.pulled}, applied ${r.applied}`, 'success');
            else toast('Sync skipped.', 'info');
            paint();
          } catch (e) { toast(e.message, 'error'); }
        },
      }, [icon('refresh', { size: 16 }), 'Sync now']);

      const disconnectBtn = el('button', {
        class: 'btn btn--danger',
        onClick: async () => {
          const ok = await modal({
            title: 'Disconnect from this server?',
            body: el('p', { style: 'margin:0;' }, [`This computer will stop syncing with ${whereNow()}. Records already on this computer are kept — nothing is deleted.`]),
            confirmText: 'Disconnect', cancelText: 'Cancel', danger: true,
          });
          if (!ok) return;
          try { await api.cloudDisconnect(); toast('Disconnected.', 'success'); paint(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }, [icon('logout', { size: 16 }), 'Disconnect']);

      return el('div', { class: 'card' }, [
        el('div', { class: 'card-head-row' }, [
          el('div', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Connection']),
          pill,
        ]),
        el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
          'Sharing one live queue with ',
          el('strong', {}, [kind === 'lan' ? netLabel(st.lanName) : host]),
          kind === 'lan' ? (st.isHost ? ', hosted on this laptop.' : `, at ${host}.`) : '.',
          st.lastOk ? ` Last synced ${new Date(st.lastOk).toLocaleTimeString()}.` : '',
        ]),
        st.lastError ? el('p', { class: 'muted small cloud-last-error', style: 'margin:0 0 var(--space-3);' }, [st.lastError]) : null,
        // A paused laptop collects nothing, so its changes are dated when it
        // is resumed and beat what other laptops changed meanwhile, later
        // changes included. Said here, where the pause is undone.
        st.online ? null : el('p', { class: 'muted small cloud-paused-note', style: 'margin:0 0 var(--space-3);' }, [
          'While sync is paused, changes made here count as made when you resume, so they replace other laptops\' changes to the same records made in the meantime. Resume as soon as the connection is back.',
        ]),
        // The host stops with Stop hosting, which also disconnects it.
        el('div', { class: 'action-row' }, [toggle, syncNowBtn, st.isHost ? null : disconnectBtn]),
        el('div', { class: 'subtle small', style: 'margin-top:var(--space-3);' }, [`Device ID: ${st.deviceId || '—'}`]),
      ]);
    }

    /* ---------- Connect another laptop: the code, on request ---------- */
    // The code is fetched only when asked for, and shown in a dialog that
    // takes it off the screen again on Done — it is the clinic key, and this
    // tab can stay open on a laptop at the front desk.
    async function showCode() {
      let r;
      try { r = await api.cloudConnectionCode(); } catch (e) { toast(e.message, 'error'); return; }
      const where = kind === 'lan' ? netLabel(st.lanName) : hostOf(st.url);
      const input = el('input', {
        class: 'input cloud-code', readonly: true, value: r.code,
        style: 'font-family:var(--font-mono);font-size:var(--fs-sm)',
      });
      const copyBtn = el('button', { class: 'btn btn--primary', type: 'button' }, [icon('save', { size: 14 }), 'Copy code']);
      copyBtn.addEventListener('click', async () => {
        try { input.select(); if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(r.code); else document.execCommand('copy'); toast('Code copied', 'success'); }
        catch (_) { input.select(); document.execCommand('copy'); toast('Code copied', 'success'); }
      });
      // On the clinic network, a laptop that picks this host from the list
      // it finds types the key instead — so the key is shown here too, in
      // the same dialog, behind the same click.
      const keyLine = r.lan && r.key ? el('div', { style: 'margin:12px 0 0' }, [
        el('p', { class: 'subtle small', style: 'margin:0 0 6px' }, [`Or, on the other laptop, pick ${where} from the clinic networks found and type this clinic key:`]),
        el('input', { class: 'input cloud-key', readonly: true, value: r.key, style: 'font-family:var(--font-mono);font-size:var(--fs-sm)' }),
      ]) : null;
      await modal({
        title: 'Connection code',
        body: el('div', {}, [
          el('p', { class: 'subtle small', style: 'margin:0 0 10px' }, [r.lan
            ? `Connects a laptop to ${where}: the host's address, the clinic key and the host's security fingerprint, in one piece. Paste it in Admin → Cloud → Clinic network, or in "Join a clinic already set up" on the sign-in screen.`
            : `Connects a laptop to ${where}: the server address and the clinic key, in one piece. Paste it in Admin → Cloud, or in "Join a clinic already set up" on the sign-in screen.`]),
          el('div', { class: 'inline-row', style: 'gap:8px' }, [input, copyBtn]),
          keyLine,
          el('div', { class: 'banner banner--warn', style: 'margin:12px 0 0' }, [
            icon('alert', { size: 14 }),
            el('span', {}, ['This is a password. Share it only with your own clinic\'s staff, in person or by private message.']),
          ]),
        ]),
        confirmText: 'Done',
      });
    }
    function anotherLaptopCard() {
      return el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('users', { size: 15 }), 'Connect another laptop']),
        el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [kind === 'lan'
          ? 'Every laptop at the clinic joins this same clinic network, with the same clinic key. The connection code carries the host\'s address, the key and its security fingerprint, so the next laptop is one paste. Or pick this clinic network from the list the next laptop finds, and type the clinic key.'
          : 'Every laptop at the clinic connects to this same server, with the same clinic key. The connection code carries both, so the next laptop is one paste instead of two things to retype.']),
        el('div', { class: 'banner banner--warn' }, [
          icon('alert', { size: 14 }),
          el('span', {}, ['The code is the clinic\'s password. Anyone who has it can read and change every patient record this clinic syncs. Share it only with your own clinic\'s staff — never in a public post, a group chat or an email to anyone outside the clinic.']),
        ]),
        el('div', { class: 'action-row' }, [
          el('button', { class: 'btn btn--ghost', onClick: showCode }, [icon('lock', { size: 16 }), 'Show connection code']),
        ]),
      ]);
    }

    if (choice === 'lan') { await clinicNetworkPanel(); return; }

    /* ---------- Internet server: not connected (the default state) ---------- */
    if (!st.configured) {
      const step = (lead, rest) => el('li', { style: 'margin:0 0 var(--space-2);' }, [el('strong', {}, [lead]), ' ', rest]);
      body.append(
        el('p', { class: 'view-sub', style: 'margin:0 0 var(--space-4);' }, [
          'This clinic is not connected to a sync server. Every record stays on this computer.',
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title' }, [icon('database', { size: 15 }), 'Local only']),
          el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
            'Patients checked in here are visible on this computer only. To share one live queue across the clinic\'s laptops:',
          ]),
          el('ol', { class: 'cloud-steps small', style: 'margin:0 0 var(--space-3); padding-left:1.4em; line-height:1.55;' }, [
            step('Someone sets up the clinic\'s sync server, once.',
              'About 10 minutes in a web browser, on a free Cloudflare account. Mission Minded does not run a shared server — each clinic has its own.'),
            step('They give you its address and the clinic key',
              '— or a single connection code, copied from a laptop that is already connected.'),
            step('Enter them below, on every laptop the clinic uses.',
              'A laptop that is new to the clinic can also do it from the sign-in screen, with "Join a clinic already set up".'),
          ]),
          usedBanner(),
          el('div', { class: 'inline-row' }, [
            el('button', { class: 'btn btn--ghost btn--sm', onClick: () => api.openExternal(SETUP_GUIDE_URL) },
              [icon('globe', { size: 14 }), 'Open the setup guide']),
            el('span', { class: 'subtle small' }, ['Step by step, for whoever sets up the server.']),
          ]),
        ]),
      );
    }

    /* ---------- Connect / change the server ---------- */
    const onInternet = kind === 'internet';
    const urlInput = el('input', {
      class: 'input', type: 'url', value: onInternet ? (st.url || '') : '',
      placeholder: 'https://mmw-sync.<your-subdomain>.workers.dev',
    });
    const keyInput = el('input', {
      class: 'input', type: 'password',
      placeholder: onInternet && st.hasKey ? 'Leave blank to keep the saved key' : 'Clinic key',
    });

    // One way to connect, however the address and key arrive — typed, or read
    // from a pasted code — so a code is held to exactly the test typing is.
    async function connect(url, key, btn) {
      if (!url) { toast('Enter the address of your clinic\'s sync server.', 'error'); return; }
      if (!st.hasKey && !key) { toast('Enter the clinic key for this server.', 'error'); return; }
      // The saved key is kept for the server it was saved for, never sent to
      // another (main refuses it). Tested without one, the new server answered
      // 401, read as "refused the clinic key", when none was given.
      if (!key && st.configured && (!onInternet || originOf(url) !== originOf(st.url))) {
        toast('Enter the clinic key for this server as well as its address.', 'error'); return;
      }
      btn.disabled = true;
      try {
        await api.cloudTest(url, key);
        // Saving a different server sends every record here to it — the
        // previous clinic's patients included — the moment it is saved. The
        // "Already used this laptop?" warning is only on the screen of a
        // laptop that is not connected, so a connected one asks here first.
        if (st.configured && (!onInternet || originOf(url) !== originOf(st.url))) {
          if (!(await askMove(hostOf(url), 'Saving'))) return;
        }
        await api.cloudConfig({ url, key: key ? key : undefined, online: true });
        toast('Connected.', 'success');
        paint();
      } catch (e) { toast(e.message, 'error'); }
      finally { btn.disabled = false; }
    }

    const connectBtn = el('button', {
      class: 'btn btn--primary',
      onClick: () => connect(urlInput.value.trim(), keyInput.value, connectBtn),
    }, [icon('globe', { size: 16 }), onInternet ? 'Save server' : 'Connect']);

    // A pasted code fills the two boxes — so the administrator sees which
    // server it names — and connects through them. Offered while this laptop
    // is not connected; a connected one is where codes come from. A clinic
    // network's code pasted here joins that clinic network instead.
    const codeInput = el('input', {
      class: 'input', autocomplete: 'off', spellcheck: 'false', placeholder: 'MMW1-…',
      style: 'font-family:var(--font-mono);',
    });
    const codeBtn = el('button', { class: 'btn btn--primary', onClick: () => useCode() },
      [icon('globe', { size: 16 }), 'Connect with code']);
    async function useCode() {
      let read;
      try { read = readConnectionCode(codeInput.value); } catch (e) { toast(e.message, 'error'); return; }
      if (read.lan) { codeInput.value = ''; await joinLan(read.url, read.key, read.lan, codeBtn); return; }
      urlInput.value = read.url;
      keyInput.value = read.key;
      await connect(read.url, read.key, codeBtn);
    }
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') useCode(); });

    body.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [icon('globe', { size: 15 }), onInternet ? 'Sync server' : 'Connect a sync server']),
      onInternet ? null : el('div', { class: 'form-grid' }, [
        el('label', { class: 'field span-2' }, [
          el('span', { class: 'field-label' }, ['Connection code']), codeInput,
          el('span', { class: 'field-hint' }, ['From a laptop that is already connected: Admin → Cloud → Show connection code.']),
        ]),
      ]),
      onInternet ? null : el('div', { class: 'action-row' }, [codeBtn]),
      onInternet ? null : el('div', { class: 'login-divider' }, [el('span', {}, ['or type the address and key'])]),
      el('div', { class: 'form-grid' }, [
        el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Server address']), urlInput]),
        el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Clinic key']), keyInput]),
      ]),
      el('div', { class: 'action-row' }, [connectBtn]),
    ]));

    /* ---------- Connected: status and controls ---------- */
    if (onInternet) body.append(connectionCard(), anotherLaptopCard());

    /* ================= The clinic network (no internet) ================= */
    async function clinicNetworkPanel() {
      let hs = null;
      let hubErr = '';
      try { hs = await api.hubStatus(); } catch (e) { hubErr = e.message; }
      const ownId = (hs && hs.hostId) || '';
      const onOwn = kind === 'lan' && !!ownId && st.lanHost === ownId;
      const hostingHere = !!hs && hs.running;

      if (kind === 'lan') body.append(connectionCard());
      if (hostingHere || onOwn) body.append(hostingCard(hs));
      else {
        if (!st.configured) body.append(introCard());
        if (kind === 'lan') body.append(joinedCard());
        body.append(joinCard(), hostOfferCard(hs, hubErr));
      }
      if (kind === 'lan') body.append(anotherLaptopCard());
    }

    // Not connected: what the clinic network is, in the order it is set up.
    function introCard() {
      const step = (lead, rest) => el('li', { style: 'margin:0 0 var(--space-2);' }, [el('strong', {}, [lead]), ' ', rest]);
      return el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('database', { size: 15 }), 'Clinic network — no internet needed']),
        el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
          'Every record stays on this computer until it hosts or joins a clinic network. To share one live queue across the clinic\'s laptops with no internet:',
        ]),
        el('ol', { class: 'cloud-steps small lan-steps', style: 'margin:0 0 var(--space-3); padding-left:1.4em; line-height:1.55;' }, [
          step('Connect every laptop to the same Wi-Fi router.', 'Any router will do, with a Wi-Fi password (WPA2 or WPA3). It does not need internet.'),
          step('On one laptop, press Host the clinic network.', 'Choose the laptop that stays on, plugged in, all day.'),
          step('On every other laptop, join it.', 'Pick it from the clinic networks found and type its clinic key — or paste its connection code.'),
        ]),
        usedBanner(),
      ]);
    }

    // The firewall, said for the laptop it is on. Windows asks on first
    // hosting; the installer cannot add the rule (it installs per user).
    function firewallHelp(h) {
      const lines = [];
      if (h.platform === 'win32') {
        lines.push(
          el('p', { style: 'margin:0 0 6px;' }, [el('strong', {}, ['Windows: ']), 'the first time this laptop hosts, Windows shows "Windows Defender Firewall has blocked some features of this app". Tick Private networks, then press Allow access.']),
          el('p', { style: 'margin:0 0 6px;' }, ['Set this laptop\'s Wi-Fi to a Private network: Settings → Network & internet → Wi-Fi → the clinic\'s network → Network profile type → Private network.']),
          el('p', { style: 'margin:0;' }, ['Missed that message, or pressed Cancel? Press Allow through the firewall (Windows asks for permission first) — or in Windows Security → Firewall & network protection → Allow an app through firewall → Change settings, tick Private beside Mission Minded.']),
        );
      } else if (h.platform === 'darwin') {
        lines.push(el('p', { style: 'margin:0;' }, [el('strong', {}, ['macOS: ']), 'if it asks whether "Mission Minded" may accept incoming network connections, press Allow. If it was denied: System Settings → Network → Firewall → Options, and allow Mission Minded.']));
      } else {
        lines.push(el('p', { style: 'margin:0;' }, [`If this laptop runs a firewall, allow incoming connections to Mission Minded (port ${h.port || 47800}, and UDP port 47801 for finding it).`]));
      }
      const fwBtn = h.firewallHelper ? el('button', {
        class: 'btn btn--ghost btn--sm',
        onClick: async () => {
          fwBtn.disabled = true;
          try { await api.hubFirewall(); toast('Mission Minded is allowed through the firewall on Private networks.', 'success'); }
          catch (e) { toast(e.message, 'error'); }
          finally { fwBtn.disabled = false; }
        },
      }, [icon('lock', { size: 14 }), 'Allow through the firewall']) : null;
      return el('div', { class: 'update-status lan-firewall', style: 'display:block; margin:0 0 var(--space-3);' }, [
        ...lines,
        fwBtn ? el('div', { class: 'inline-row' }, [fwBtn]) : null,
      ]);
    }

    // This laptop hosts: where the others reach it, who is connected, and
    // how to stop.
    function hostingCard(h) {
      h = h || { addresses: [], laptops: [] };
      const pill = h.running
        ? (h.error ? el('span', { class: 'pill pill--amber' }, [icon('alert', { size: 12 }), 'Problem'])
          : el('span', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Hosting']))
        : el('span', { class: 'pill pill--neutral' }, ['Not hosting']);
      const reach = (h.addresses || []).filter((a) => a.url);
      const kv = (label, val, extra = {}) => el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, [label]), el('span', { class: 'kv-val', ...extra }, [val])]);
      const laptops = h.laptops || [];
      const others = laptops.filter((l) => !l.self);
      const stopBtn = el('button', {
        class: 'btn btn--danger',
        onClick: async () => {
          const ok = await modal({
            title: 'Stop hosting the clinic network?',
            body: el('div', {}, [
              el('p', { style: 'margin:0 0 var(--space-3);' }, ['The other laptops keep working on their own, and catch up when a laptop hosts again. This laptop stops syncing until then; its records stay on it.']),
              el('p', { style: 'margin:0;' }, ['What the clinic network holds stays on this laptop too, so hosting again here carries on where it left off, with the same connection code.']),
            ]),
            confirmText: 'Stop hosting', cancelText: 'Cancel', danger: true,
          });
          if (!ok) return;
          try { await api.hubStop(false); cloudChoice = 'lan'; toast('Stopped hosting.', 'success'); paint(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }, [icon('x', { size: 16 }), 'Stop hosting']);
      const againBtn = h.running ? null : el('button', {
        class: 'btn btn--primary',
        onClick: async () => {
          againBtn.disabled = true;
          try { await api.hubStart(h.name); toast('This laptop is hosting the clinic network again.', 'success'); paint(); }
          catch (e) { toast(e.message, 'error'); }
          finally { againBtn.disabled = false; }
        },
      }, [icon('refresh', { size: 16 }), 'Host again']);
      return el('div', { class: 'card lan-hosting' }, [
        el('div', { class: 'card-head-row' }, [
          el('div', { class: 'card-title' }, [icon('database', { size: 15 }), 'This laptop hosts the clinic network']),
          pill,
        ]),
        h.error ? el('div', { class: 'banner banner--alert' }, [icon('alert', { size: 14 }), el('span', {}, [h.error])]) : null,
        el('div', { class: 'kv-grid', style: 'margin:0 0 var(--space-3);' }, [
          kv('Clinic network', h.name || 'Clinic network'),
          kv('Other laptops reach it at', reach.length ? reach[0].url.replace(/^https:\/\//, '') : 'Not on a network', { class: 'kv-val lan-address' }),
          kv('Laptops connected now', String(others.length)),
        ]),
        reach.length ? null : el('div', { class: 'banner banner--warn' }, [icon('alert', { size: 14 }), el('span', {}, ['This laptop is not on any network yet. Connect it to the clinic\'s Wi-Fi router — the other laptops reach it there.'])]),
        reach.length > 1 ? el('p', { class: 'subtle small', style: 'margin:0 0 var(--space-3);' }, [
          'This laptop is on more than one network. Its other addresses: ', reach.slice(1).map((a) => `${a.url.replace(/^https:\/\//, '')} (${a.iface})`).join(', '), '.',
        ]) : null,
        el('div', { class: 'kv', style: 'margin:0 0 var(--space-3);' }, [
          el('span', { class: 'kv-label' }, ['Security fingerprint']),
          el('span', { class: 'kv-val lan-fingerprint', style: 'font-family:var(--font-mono); font-size:var(--fs-sm);' }, [h.pinShown || '—']),
          el('span', { class: 'field-hint' }, ['Every laptop that joins checks it by itself. It is here to compare by eye, if anyone asks.']),
        ]),
        laptops.length ? el('div', { class: 'data-table-wrap', style: 'margin:0 0 var(--space-3);' }, [
          el('table', { class: 'data-table data-table--mini lan-laptops' }, [
            el('thead', {}, [el('tr', {}, ['Laptop', 'Address', 'Last synced'].map((x) => el('th', {}, [x])))]),
            el('tbody', {}, laptops.map((l) => el('tr', {}, [
              el('td', {}, [l.self ? `${l.computer} (this laptop)` : l.computer]),
              el('td', {}, [l.address]),
              el('td', {}, [new Date(l.lastSeen).toLocaleTimeString()]),
            ]))),
          ]),
        ]) : el('p', { class: 'subtle small', style: 'margin:0 0 var(--space-3);' }, ['No other laptop has joined yet.']),
        el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
          'Keep this laptop on, plugged in and awake while the clinic is open. If it sleeps or is switched off, the other laptops keep working on their own and catch up when it is back — it hosts again by itself when the app opens.',
        ]),
        firewallHelp(h),
        el('div', { class: 'action-row' }, [againBtn, stopBtn]),
      ]);
    }

    // Joined to another laptop's clinic network: which, and the test.
    function joinedCard() {
      const result = el('div', { class: 'update-status lan-test-result', style: 'display:none; margin-top:var(--space-3);' });
      const testBtn = el('button', {
        class: 'btn btn--ghost',
        onClick: async () => {
          testBtn.disabled = true;
          result.style.display = '';
          result.replaceChildren(icon('info', { size: 16 }), el('span', {}, ['Testing the clinic network…']));
          try {
            await api.cloudTest(st.url, '', { pin: st.lanPin, hostId: st.lanHost, name: st.lanName });
            result.replaceChildren(icon('checkCircle', { size: 16 }), el('span', {}, ['The clinic network is working: the host answers, its certificate matches, and it accepts this laptop\'s key.']));
          } catch (e) {
            result.replaceChildren(icon('alert', { size: 16 }), el('span', {}, [e.message]));
          } finally { testBtn.disabled = false; }
        },
      }, [icon('refresh', { size: 16 }), 'Test the clinic network']);
      return el('div', { class: 'card lan-joined' }, [
        el('div', { class: 'card-title' }, [icon('globe', { size: 15 }), 'Clinic network']),
        el('div', { class: 'kv-grid', style: 'margin:0 0 var(--space-3);' }, [
          el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, ['Clinic network']), el('span', { class: 'kv-val' }, [st.lanName || 'Clinic network'])]),
          el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, ['Host']), el('span', { class: 'kv-val' }, [hostOf(st.url)])]),
          el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, ['Security fingerprint']), el('span', { class: 'kv-val', style: 'font-family:var(--font-mono);' }, [`${st.lanPinShown || '—'} …`])]),
        ]),
        el('p', { class: 'muted small', style: 'margin:0;' }, [
          'If the host laptop gets a new address from the router, this laptop finds it again by itself. Not syncing? The test says why — host not found, its firewall, the wrong certificate or the wrong key.',
        ]),
        el('div', { class: 'action-row' }, [testBtn]),
        result,
      ]);
    }

    // Joining: the hosts this laptop hears, or a code, or a typed address.
    function joinCard() {
      let picked = null;   // the host chosen from the list: { hostId, fp, name }
      const found = el('div', { class: 'lan-found', style: 'display:flex; flex-direction:column; gap:8px; margin:0 0 var(--space-3);' }, [
        el('p', { class: 'subtle small', style: 'margin:0;' }, ['Looking for clinic networks on this Wi-Fi…']),
      ]);
      const addrInput = el('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', placeholder: '192.168.1.23:47800' });
      const keyIn = el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Clinic key' });
      addrInput.addEventListener('input', () => { picked = null; });
      const codeIn = el('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', placeholder: 'MMW1-…', style: 'font-family:var(--font-mono);' });
      const codeJoinBtn = el('button', { class: 'btn btn--primary', onClick: () => joinWithCode() }, [icon('globe', { size: 16 }), 'Join with code']);
      const joinBtn = el('button', { class: 'btn btn--primary', onClick: () => joinLan(addrInput.value.trim(), keyIn.value, picked || {}, joinBtn) }, [icon('globe', { size: 16 }), 'Join']);
      async function joinWithCode() {
        let read;
        try { read = readConnectionCode(codeIn.value); } catch (e) { toast(e.message, 'error'); return; }
        if (!read.lan) { toast('That code is for an internet server. Choose Internet server above and paste it there.', 'error'); return; }
        codeIn.value = '';
        await joinLan(read.url, read.key, read.lan, codeJoinBtn);
      }
      codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinWithCode(); });
      keyIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

      function showFound(list) {
        if (!list.length) {
          found.replaceChildren(el('p', { class: 'subtle small lan-none', style: 'margin:0;' }, [
            'No clinic network found on this Wi-Fi. Check the host laptop is on and hosting, and that this laptop is on the same Wi-Fi — or type the host\'s address below (its Cloud tab shows it).',
          ]));
          return;
        }
        found.replaceChildren(...list.map((b) => {
          const addr = `${b.address}:${b.port}`;
          return el('div', { class: 'conn-item lan-host', style: 'flex-direction:row; align-items:center; justify-content:space-between;' }, [
            el('div', { style: 'display:flex; flex-direction:column; gap:2px;' }, [
              el('strong', {}, [b.name]),
              el('span', {}, [b.self ? `${addr} — this laptop` : addr]),
            ]),
            b.self ? null : el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              onClick: () => { addrInput.value = addr; picked = { hostId: b.hostId, fp: b.fp, name: b.name }; keyIn.focus(); },
            }, ['Choose']),
          ]);
        }));
      }
      function look() {
        found.replaceChildren(el('p', { class: 'subtle small', style: 'margin:0;' }, ['Looking for clinic networks on this Wi-Fi…']));
        api.lanScan().then((list) => showFound(list || [])).catch((e) => {
          found.replaceChildren(el('p', { class: 'subtle small', style: 'margin:0;' }, [e.message]));
        });
      }
      look();

      return el('div', { class: 'card lan-join' }, [
        el('div', { class: 'card-head-row' }, [
          el('div', { class: 'card-title' }, [icon('users', { size: 15 }), kind === 'lan' ? 'Join a different clinic network' : 'Join a clinic network']),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: look }, [icon('refresh', { size: 14 }), 'Look again']),
        ]),
        el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
          'Choose the host laptop from the clinic networks found on this Wi-Fi, then type the clinic key its Cloud tab shows — or paste its connection code.',
        ]),
        found,
        el('div', { class: 'form-grid' }, [
          el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Host address']), addrInput,
            el('span', { class: 'field-hint' }, ['Filled in when you choose a host above. Not listed? Type the address the host\'s Cloud tab shows.'])]),
          el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Clinic key']), keyIn]),
        ]),
        el('div', { class: 'action-row' }, [joinBtn]),
        el('div', { class: 'login-divider' }, [el('span', {}, ['or paste a connection code'])]),
        el('div', { class: 'form-grid' }, [
          el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Connection code']), codeIn,
            el('span', { class: 'field-hint' }, ['From the host laptop: Admin → Cloud → Show connection code.'])]),
        ]),
        el('div', { class: 'action-row' }, [codeJoinBtn]),
      ]);
    }

    // Hosting here: one laptop, chosen for staying on.
    function hostOfferCard(h, err) {
      const before = !!h && h.hasData && !h.running;
      const nameIn = el('input', {
        class: 'input', autocomplete: 'off',
        value: (before && h.name) || (store.event && store.event.name) || 'Clinic network',
      });
      const hostBtn = el('button', {
        class: 'btn btn--primary',
        onClick: async () => {
          const name = nameIn.value.trim();
          if (!name) { toast('Give the clinic network a name, so the other laptops can tell it from any other.', 'error'); return; }
          if (st.configured && !(await askMove(netLabel(name) + ' on this laptop', 'Hosting'))) return;
          hostBtn.disabled = true;
          try {
            await api.hubStart(name, st.configured);
            cloudChoice = 'lan';
            toast('This laptop is hosting the clinic network.', 'success');
            paint();
          } catch (e) { toast(e.message, 'error'); }
          finally { hostBtn.disabled = false; }
        },
      }, [icon('database', { size: 16 }), before ? 'Host it again' : 'Host the clinic network']);
      const eraseBtn = before ? el('button', {
        class: 'btn btn--ghost',
        onClick: async () => {
          const ok = await modal({
            title: 'Erase the clinic network hosted on this laptop?',
            body: el('div', {}, [
              el('p', { style: 'margin:0 0 var(--space-3);' }, [`This deletes what ${netLabel(h.name)} kept on this laptop — its copy of the clinic's records, its security certificate and its clinic key. This laptop's own records stay, and so do every other laptop's.`]),
              el('p', { style: 'margin:0;' }, ['The laptops that joined it stop syncing with it. Hosting here afterwards makes a new clinic network, with a new connection code, which every laptop joins again.']),
            ]),
            confirmText: 'Erase', cancelText: 'Cancel', danger: true,
          });
          if (!ok) return;
          try { await api.hubStop(true); toast('Clinic network erased from this laptop.', 'success'); paint(); }
          catch (e) { toast(e.message, 'error'); }
        },
      }, [icon('trash', { size: 16 }), 'Erase the clinic network data']) : null;
      return el('div', { class: 'card lan-host-offer' }, [
        el('div', { class: 'card-title' }, [icon('database', { size: 15 }), kind === 'lan' ? 'Host the clinic network on this laptop instead' : 'Host the clinic network on this laptop']),
        el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
          'Choose the laptop that stays on, plugged in, for the whole clinic day — the registration laptop is a good choice. The other laptops join it. If it is off or asleep, they keep working on their own and catch up when it is back.',
        ]),
        before ? el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
          `This laptop hosted ${netLabel(h.name)} before. Hosting it again carries on with the same clinic network: the laptops that joined it reconnect by themselves.`,
        ]) : null,
        err ? el('p', { class: 'subtle small', style: 'margin:0 0 var(--space-3);' }, [err]) : null,
        el('div', { class: 'form-grid' }, [
          el('label', { class: 'field span-2' }, [el('span', { class: 'field-label' }, ['Clinic network name']), nameIn,
            el('span', { class: 'field-hint' }, ['What the other laptops see in their list — the clinic\'s name and place is good.'])]),
        ]),
        el('div', { class: 'action-row' }, [hostBtn, eraseBtn]),
      ]);
    }
  }

  /* ---- Audit ---- */
  async function auditTab(body) {
    const log = await api.audit(200);
    clear(body);
    body.append(el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Audit log']),
      el('p', { class: 'muted', style: 'margin:0 0 var(--space-4);' }, ['A record of recent activity across the clinic — who did what, and when.']),
      el('div', { class: 'data-table-wrap' }, [
        el('table', { class: 'data-table data-table--mini' }, [
          el('thead', {}, [el('tr', {}, ['When', 'User', 'Action', 'Entity', 'Detail'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, log.map((a) => el('tr', {}, [
            el('td', {}, [new Date(a.created_at).toLocaleString()]),
            el('td', {}, [a.user_name || '—']),
            el('td', {}, [a.action]),
            el('td', {}, [`${a.entity || ''}${a.entity_id ? ' #' + a.entity_id : ''}`]),
            el('td', {}, [a.detail || '—']),
          ]))),
        ]),
      ]),
    ]));
  }

  paint();
  return root;
}
