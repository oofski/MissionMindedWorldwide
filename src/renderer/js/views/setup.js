// First-run setup: the screen a clinic laptop shows before it has an account.
//
// Replaces the old shipped admin/admin, which meant every install of an app
// holding patient records had the same known password until somebody
// remembered to change it.
//
// Two ways through, because a clinic runs on several laptops:
//   Start — this is the first computer. Create the administrator here.
//   Join  — the clinic already exists on another computer. Point this machine
//           at the same clinic cloud; the staff accounts sync down and everyone
//           signs in with the account they already have.

import { el, toast, withBusy } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { readConnectionCode } from '../connectionCode.js';

export function renderSetup(ctx, params = {}) {
  // Reached two ways now. A machine with no account at all still lands here on
  // 'start'; a normal install, which ships with an administrator already, only
  // gets here from the sign-in screen's "Join a clinic" button — so honour the
  // mode the caller asked for and keep the Start form out of its way, since
  // createFirstAdmin would refuse it anyway once an account exists.
  let mode = params.mode === 'join' ? 'join' : 'start';
  const joinOnly = params.mode === 'join';

  const root = el('div', { class: 'auth-split' });

  /* ---------------- Start a new clinic ---------------- */

  function startForm() {
    const fullName = el('input', { class: 'input', placeholder: 'e.g. Anna Reed', autocomplete: 'off' });
    const username = el('input', { class: 'input', placeholder: 'e.g. anna.reed', autocomplete: 'off' });
    const password = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const confirm = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const clinic = el('input', { class: 'input', placeholder: 'e.g. Yorba Linda Clinic' });
    const error = el('div', { class: 'login-error', style: 'display:none' });
    const submitBtn = el('button', { class: 'btn btn--primary btn--block' }, [icon('chevron', { size: 16 }), 'Create administrator']);

    function fail(msg) { error.textContent = msg; error.style.display = 'block'; }

    async function submit() {
      error.style.display = 'none';
      // Checked here as well as in the data layer so the person gets the
      // message beside the field rather than after a round trip.
      if (!fullName.value.trim()) return fail('Please enter your name.');
      if (!username.value.trim()) return fail('Please choose a username.');
      if (password.value.length < 8) return fail('Password must be at least 8 characters.');
      if (password.value !== confirm.value) return fail('The two passwords do not match.');

      try {
        const user = await withBusy(submitBtn, () => api.setupAdmin({
          full_name: fullName.value.trim(),
          username: username.value.trim(),
          password: password.value,
          clinic_name: clinic.value.trim(),
        }));
        // setupAdmin signs the new administrator in, so go straight to work
        // rather than making them retype the password they just chose.
        store.setUser(user);
        const ev = await api.activeEvent();
        store.setEvent(ev);
        if (ctx.afterLogin) ctx.afterLogin();
        toast('Administrator created. Add your staff under Admin → Staff & roles.', 'success');
        ctx.navigate('dashboard');
      } catch (e) {
        fail(e.message || 'Could not complete setup.');
      }
    }

    submitBtn.addEventListener('click', submit);
    [fullName, username, password, confirm, clinic].forEach((inp) =>
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }));
    setTimeout(() => fullName.focus(), 0);

    return el('div', { class: 'auth-form' }, [
      el('h2', { class: 'auth-title' }, ['Set up this computer']),
      el('p', { class: 'auth-sub' }, ['You are the first person here. Create the administrator account — you can add everyone else once you are in.']),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Your full name']), fullName]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Username']), username]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Password']), password]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Confirm password']), confirm]),
      el('p', { class: 'subtle small', style: 'margin:-6px 0 18px' }, ['At least 8 characters. There is no way to recover it, so write it down somewhere safe.']),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Clinic name (optional)']), clinic]),
      error,
      submitBtn,
      el('div', { class: 'login-divider' }, [el('span', {}, ['or'])]),
      el('button', { class: 'btn btn--ghost btn--block', onClick: () => { mode = 'join'; paint(); } },
        [icon('globe', { size: 16 }), 'Join a clinic already set up']),
    ]);
  }

  /* ---------------- Join an existing clinic ---------------- */

  // v0.0.16: this went through cloud:test and cloud:config, which are the
  // administrator's — and nobody is signed in here — so in the installed app
  // Join answered "Please sign in first" and never connected anything. It now
  // has its own channel (cloud:join), which runs the same test as typing the
  // address in Admin → Cloud and is open signed-out only while this computer
  // has no administrator password of its own (see ipc.js). It also takes the
  // connection code a connected laptop hands out, so the address and key are
  // one paste instead of two things to retype.
  function joinForm() {
    const code = el('input', { class: 'input', placeholder: 'MMW1-…', autocomplete: 'off', spellcheck: 'false', style: 'font-family:var(--font-mono);' });
    const url = el('input', { class: 'input', placeholder: 'https://mmw-sync.<subdomain>.workers.dev' });
    const key = el('input', { class: 'input', type: 'password', placeholder: 'Clinic key' });
    const status = el('div', { class: 'update-status', style: 'display:none' });
    const error = el('div', { class: 'login-error', style: 'display:none' });
    const joinBtn = el('button', { class: 'btn btn--primary btn--block' }, [icon('globe', { size: 16 }), 'Connect and sync']);

    function fail(msg) { status.style.display = 'none'; error.textContent = msg; error.style.display = 'block'; }
    function say(msg) { status.style.display = ''; status.replaceChildren(icon('info', { size: 16 }), el('span', {}, [msg])); }

    async function join() {
      error.style.display = 'none';
      // A pasted code fills the two boxes below — so the person sees which
      // server it names — and is then connected exactly as if they had typed.
      if (code.value.trim()) {
        let read;
        try { read = readConnectionCode(code.value); } catch (e) { return fail(e.message); }
        url.value = read.url;
        key.value = read.key;
      }
      if (!url.value.trim()) return fail('Enter the clinic address your administrator gave you, or paste a connection code.');
      if (!key.value) return fail('Enter the clinic key as well as the address.');
      try {
        await withBusy(joinBtn, async () => {
        say('Checking the clinic address, then downloading the clinic…');
        const r = await api.cloudJoin(url.value.trim(), key.value);

        // Accounts replicate with everything else, so once the pull lands this
        // machine has the clinic's real staff list and setup is finished.
        if (r.sync && r.sync.ok === false) {
          fail(`Connected, but the clinic has not finished downloading (${r.sync.error || 'no answer yet'}). It keeps trying on its own — wait a minute, then sign in.`);
          return;
        }
        // Whether the clinic actually ARRIVED is r.accounts — the accounts here
        // besides the shipped admin / admin. This used to ask needsSetup, which
        // is false on every normal install (admin / admin is always there), so
        // an empty server — the first laptop not connected yet — was reported
        // as "Clinic downloaded" and the person's own account then failed.
        if (r.needsSetup || r.accounts === 0) {
          // The admin / admin way out exists only where admin / admin does —
          // not on a computer just erased with Reset this computer.
          fail('Connected, but no staff accounts came down yet. Check the first laptop is signed in and its Cloud tab says Online. This laptop stays connected and picks them up by itself — press Connect and sync again in a minute.'
            + (r.needsSetup ? '' : ' If the clinic has no account but admin / admin so far, go back and sign in with that.'));
          return;
        }
        toast('Clinic downloaded. Sign in with your own account.', 'success');
        ctx.navigate('login');
        });
      } catch (e) {
        fail(e.message || 'Could not reach that clinic.');
      }
    }

    joinBtn.addEventListener('click', join);
    [code, url, key].forEach((inp) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); }));
    setTimeout(() => code.focus(), 0);

    const backBtn = () => (joinOnly
      ? el('button', { class: 'btn btn--ghost btn--block', onClick: () => ctx.navigate('login') },
          [icon('chevron', { size: 16 }), 'Back to sign in'])
      : el('button', { class: 'btn btn--ghost btn--block', onClick: () => { mode = 'start'; paint(); } },
          [icon('plus', { size: 16 }), 'This is the first computer — set it up']));

    // The sign-in screen always offers Join, but cloud:join refuses it signed
    // out once this computer has an administrator password of its own — the
    // likely state of any laptop that has been used, since the app nags until
    // admin / admin is changed. Ask first, with the same rule the handler
    // applies, rather than letting someone paste a code and type a key only to
    // be told at the end. If the question fails, the form stays; the handler
    // still refuses.
    //
    // Already connected, it is closed for a different reason: there is nothing
    // to join. That is the usual way here after a first Join that found no
    // accounts — the laptop's own sync then brought them, the clinic's
    // administrator password with them — and "connect it under Admin → Cloud"
    // told someone whose staff could already sign in to do what was done.
    const form = el('div', { class: 'auth-form' });
    api.needsSetup().then((r) => {
      if (!r || r.needsSetup || r.defaultAdmin) return;
      if (r.connected) {
        form.replaceChildren(
          el('h2', { class: 'auth-title' }, ['Join a clinic']),
          el('div', { class: 'update-status' }, [icon('info', { size: 16 }), el('span', {}, ['This computer is already connected to a clinic server, so there is nothing to join. Sign in with your own account.'])]),
          el('p', { class: 'auth-sub' }, ['To connect it to a different server, sign in as an administrator and use Admin → Cloud.']),
          backBtn(),
        );
        return;
      }
      form.replaceChildren(
        el('h2', { class: 'auth-title' }, ['Join a clinic']),
        el('div', { class: 'login-error', style: 'display:block' }, ['This computer already has its own administrator password. Sign in as an administrator and connect it under Admin → Cloud.']),
        el('p', { class: 'auth-sub' }, ['Before you do: everything already on this computer, test patients included, goes to every laptop of the clinic. And the laptops share one account named admin, so the admin password set on this computer will replace the admin password on every laptop. Give admin the same password on each laptop first.']),
        backBtn(),
      );
    }).catch(() => { /* keep the form */ });

    form.append(
      el('h2', { class: 'auth-title' }, ['Join a clinic']),
      el('p', { class: 'auth-sub' }, ['Point this computer at a clinic someone has already set up. Its staff accounts and records download to this machine, and you sign in with your own account.']),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Connection code']), code]),
      el('p', { class: 'subtle small', style: 'margin:-6px 0 0' }, ['Your administrator copies it from Admin → Cloud → Show connection code, on a laptop that is already connected.']),
      el('div', { class: 'login-divider' }, [el('span', {}, ['or type the address and key'])]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Clinic address']), url]),
      el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Clinic key']), key]),
      status,
      error,
      joinBtn,
      el('div', { class: 'login-divider' }, [el('span', {}, ['or'])]),
      backBtn(),
    );
    return form;
  }

  /* ---------------- Shell ---------------- */

  function hero() {
    const feature = (ic, title) => el('div', { class: 'auth-feature' }, [
      el('div', { class: 'auth-feature-ic' }, [icon(ic, { size: 18 })]),
      el('strong', {}, [title]),
    ]);
    return el('div', { class: 'auth-hero' }, [
      el('div', { class: 'auth-brand' }, [
        el('img', { class: 'auth-brand-mark', src: '../../assets/mmw-mark-white.png', alt: '' }),
        el('div', { class: 'auth-brand-name' }, [
          el('strong', {}, ['Mission Minded']),
          el('span', {}, ['Free Clinics']),
        ]),
      ]),
      el('div', { class: 'auth-hero-body' }, [
        el('div', { class: 'auth-eyebrow' }, ['Free dental, medical and vision clinics']),
        el('h1', { class: 'auth-headline' }, ['Set up once. The whole clinic works from it.']),
      ]),
      el('div', { class: 'auth-features' }, [
        feature('lock', 'You choose the administrator password'),
        feature('users', 'Add your team once you are in'),
        feature('database', 'Offline-first — data stays on the device'),
      ]),
    ]);
  }

  function paint() {
    root.replaceChildren(hero(), el('div', { class: 'auth-panel' }, [mode === 'start' ? startForm() : joinForm()]));
  }

  paint();
  return root;
}
