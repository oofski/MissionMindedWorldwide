'use strict';

const DL = require('./dentalLabels');

/**
 * After-care instructions: what the patient takes home, chosen from what was
 * actually DONE at the chair.
 *
 * Dr. Trinh's punch list (2026-09-28): "Report — add follow-up care
 * instructions ... can you make it dependent on the type of procedure that was
 * performed?" The templates themselves have not arrived yet, so the wording
 * below is a DRAFT: standard, conservative after-care, seeded from MMW's own
 * consent text (the post-operative instructions and the "call MMW" paragraph of
 * the oral-surgery consent). It is versioned as a draft, and every printed page
 * carries the version, so a copy handed to a patient can always be traced back
 * to the exact text it used.
 *
 * WHY A CODE FILE AND NOT AN ADMIN SETTING. Settings are per laptop and do not
 * sync, so an edit on one station would never reach the other fourteen, and
 * patients would get different instructions depending on the desk. Clinical
 * wording should be doctor-approved and versioned; the app's own update already
 * ships this file to every station at once.
 *
 * Pure CommonJS with no electron or database imports, so pdf.js, ipc.js and the
 * harness can all require it. The renderer never imports it: the check-out
 * screen asks for the sections over IPC (aftercare:get).
 *
 * TO DROP IN MMW'S TEMPLATES: edit only the block between the ==== lines —
 * each template's title and items (en and es), set its status to 'mmw', and
 * bump AFTERCARE_VERSION. Text is plain strings (pdf.js escapes it; never
 * HTML). Placeholders: {phone} everywhere; {to}, {tooth} and {reason} in the
 * referral template, where a line whose placeholder has nothing to say is left
 * out. Adding a procedure means one template, one rule in classify() below, and
 * the harness list.
 */

/* ============================ EDITABLE BLOCK ============================ */

const AFTERCARE_VERSION = 'mmw-aftercare-v1-draft';

// MMW's number — the one the About box, the oral-surgery consent and the online
// form already give. The harness pins all of them to this.
const CONTACT = { org: 'Mission Minded Worldwide', phone: '(951) 317-4968' };

// Agents whose numbness lasts well beyond the usual few hours. Keys from the
// clinic's anaesthetic list (src/renderer/i18n/strings.js ANESTHETICS).
const LONG_ACTING_ANESTHETICS = ['bupivacaine'];

// The languages the templates are written in. A patient whose language is not
// here gets English, and the page says so in English.
const LANGS = ['en', 'es'];

// Printed in this order; 'general' is always last and always printed.
const TEMPLATES = {
  extraction: {
    status: 'draft',
    title: { en: 'After a tooth extraction', es: 'Después de una extracción dental' },
    items: {
      en: [
        'Bite firmly on the gauze for 30–45 minutes. If it is still bleeding, bite on a clean, folded piece of gauze for another 30 minutes.',
        'For 24 hours, do not rinse, spit, smoke, or drink through a straw. These can pull out the blood clot that helps the area heal.',
        'Eat soft foods and chew on the other side. A little swelling, soreness and oozing of blood are normal for the first day or two.',
        'After 24 hours, rinse gently with warm salt water (half a teaspoon of salt in a cup of warm water) after meals and at bedtime. Keep brushing your other teeth gently.',
        'Take medicines only as the dental team or the package directs.',
        'Pain that gets worse 2–4 days later, instead of better, can be a "dry socket": call {phone}.',
      ],
      es: [
        'Muerda firmemente la gasa durante 30–45 minutos. Si todavía sangra, muerda una gasa limpia y doblada otros 30 minutos.',
        'Durante 24 horas no se enjuague, no escupa, no fume y no use pajilla (popote). Pueden desprender el coágulo que ayuda a sanar la zona.',
        'Coma alimentos blandos y mastique del otro lado. Es normal tener un poco de hinchazón, dolor y sangrado leve el primer o segundo día.',
        'Después de 24 horas, enjuáguese suavemente con agua tibia con sal (media cucharadita de sal en una taza de agua tibia) después de comer y al acostarse. Siga cepillando sus otros dientes con cuidado.',
        'Tome medicamentos solo como le indique el equipo dental o el empaque.',
        'Si el dolor empeora 2–4 días después en lugar de mejorar, puede ser un "alveolo seco": llame al {phone}.',
      ],
    },
  },
  extraction_surgical: {
    status: 'draft',
    title: { en: 'After a surgical extraction — also', es: 'Después de una extracción quirúrgica — además' },
    items: {
      en: [
        'For the first day, hold an ice pack wrapped in a cloth on your cheek: 20 minutes on, then 20 minutes off.',
        'Swelling and bruising are common. They are usually worst 2–3 days after the surgery and then slowly go down.',
        'Rest today, keep your head raised on pillows when lying down, and avoid heavy exercise for 2–3 days.',
        'If you have stitches, do not pull at them. Most dissolve on their own; if you were told yours need to be removed, see a dentist in about a week.',
      ],
      es: [
        'Durante el primer día, póngase en la mejilla una bolsa de hielo envuelta en un paño: 20 minutos sí y 20 minutos no.',
        'Es común tener hinchazón y moretones. Suelen ser peores 2–3 días después de la cirugía y luego bajan poco a poco.',
        'Descanse hoy, mantenga la cabeza elevada con almohadas al acostarse y evite el ejercicio fuerte durante 2–3 días.',
        'Si tiene puntos, no los jale. La mayoría se disuelven solos; si le dijeron que hay que quitarlos, vea a un dentista en una semana, más o menos.',
      ],
    },
  },
  anesthetic: {
    status: 'draft',
    title: { en: 'Numbness', es: 'Adormecimiento' },
    items: {
      en: [
        'Your lip, tongue and cheek may stay numb for a few hours.',
        'Until the numbness is gone, do not eat or chew, avoid hot drinks, and take care not to bite, scratch or burn your lip, cheek or tongue.',
        'Watch children closely until the numbness wears off — they may chew their lip or cheek without feeling it.',
        'If any numbness is still there the next day, call {phone}.',
      ],
      es: [
        'Su labio, lengua y mejilla pueden quedar adormecidos por algunas horas.',
        'Hasta que se le quite el adormecimiento, no coma ni mastique, evite las bebidas calientes y tenga cuidado de no morderse, rasguñarse ni quemarse el labio, la mejilla o la lengua.',
        'Vigile de cerca a los niños hasta que se les pase el adormecimiento: pueden morderse el labio o la mejilla sin sentirlo.',
        'Si al día siguiente todavía tiene algo de adormecimiento, llame al {phone}.',
      ],
    },
    variants: {
      long_acting: {
        en: ['You were given a long-acting anesthetic: the numbness may last much longer than usual, up to 12 hours. Take the same care until the feeling has fully come back.'],
        es: ['Le pusieron un anestésico de acción prolongada: el adormecimiento puede durar mucho más de lo normal, hasta 12 horas. Tenga el mismo cuidado hasta que recupere por completo la sensibilidad.'],
      },
    },
  },
  filling: {
    status: 'draft',
    title: { en: 'After a filling', es: 'Después de un empaste (relleno)' },
    items: {
      en: [
        'The tooth may be sensitive to cold, heat or biting for a few days, sometimes a few weeks. This usually fades on its own.',
        'If your bite feels high or uneven once the numbness is gone, or the pain gets worse instead of better, see a dentist — the filling may need adjusting.',
        'Brush twice a day with fluoride toothpaste and clean between your teeth every day.',
      ],
      es: [
        'El diente puede estar sensible al frío, al calor o al morder por unos días, a veces unas semanas. Esto suele desaparecer solo.',
        'Si al pasarse el adormecimiento siente la mordida alta o dispareja, o el dolor empeora en lugar de mejorar, vea a un dentista: puede que haya que ajustar el empaste.',
        'Cepíllese dos veces al día con pasta dental con flúor y limpie entre los dientes todos los días.',
      ],
    },
    variants: {
      core_buildup: {
        en: ['A core build-up was placed to support a crown. It is not a finished repair: see a dentist to have the crown made, and avoid biting hard foods on that tooth until then.'],
        es: ['Se le colocó una reconstrucción (muñón) para sostener una corona. No es una reparación terminada: vea a un dentista para que le hagan la corona y, mientras tanto, evite morder alimentos duros con ese diente.'],
      },
    },
  },
  temporary_filling: {
    status: 'draft',
    title: { en: 'Temporary filling', es: 'Empaste temporal' },
    items: {
      en: [
        'You have a temporary filling. It is not meant to last: see a dentist for a permanent filling or other treatment as soon as you can, ideally within a few weeks.',
        'Avoid chewing hard or sticky foods on that side.',
        'It is normal for a temporary filling to wear down a little. If it falls out or breaks, or the tooth hurts, see a dentist.',
      ],
      es: [
        'Tiene un empaste temporal. No está hecho para durar: vea a un dentista para un empaste permanente u otro tratamiento lo antes posible, idealmente en unas pocas semanas.',
        'Evite masticar alimentos duros o pegajosos de ese lado.',
        'Es normal que un empaste temporal se desgaste un poco. Si se cae o se rompe, o le duele el diente, vea a un dentista.',
      ],
    },
  },
  crown_bridge: {
    status: 'draft',
    title: { en: 'Crown or bridge', es: 'Corona o puente' },
    items: {
      en: [
        'For the first 24 hours, do not eat sticky or very hard foods (such as caramel, chewing gum or ice) on that side.',
        'Brush normally. When you floss, slide the floss out to the side rather than pulling it up.',
        'If the crown or bridge feels loose, comes off, or your bite feels high, keep it and see a dentist. Do not glue it back yourself.',
      ],
      es: [
        'Durante las primeras 24 horas, no coma alimentos pegajosos o muy duros (como caramelos, chicle o hielo) de ese lado.',
        'Cepíllese normalmente. Al usar hilo dental, sáquelo hacia un lado en lugar de jalarlo hacia arriba.',
        'Si la corona o el puente se siente flojo, se cae, o siente la mordida alta, guárdelo y vea a un dentista. No lo pegue usted mismo.',
      ],
    },
  },
  pulpotomy: {
    status: 'draft',
    title: { en: 'After a pulpotomy (nerve treatment)', es: 'Después de una pulpotomía (tratamiento del nervio)' },
    items: {
      en: [
        'The nerve at the top of the tooth was treated. The tooth may be tender for a few days.',
        'The tooth still needs a lasting repair, usually a crown or a filling. See a dentist as advised.',
        'Until then, avoid chewing hard or sticky foods on that tooth.',
        'Swelling, fever, or pain that gets worse is not normal: call {phone} or see a dentist.',
      ],
      es: [
        'Se trató el nervio de la parte de arriba del diente. El diente puede estar sensible por unos días.',
        'El diente todavía necesita una reparación duradera, por lo general una corona o un empaste. Vea a un dentista como se le indicó.',
        'Mientras tanto, evite masticar alimentos duros o pegajosos con ese diente.',
        'La hinchazón, la fiebre o un dolor que empeora no son normales: llame al {phone} o vea a un dentista.',
      ],
    },
  },
  denture: {
    status: 'draft',
    title: { en: 'Your denture', es: 'Su dentadura postiza' },
    items: {
      en: [
        'Clean your denture every day with a soft brush and mild soap or denture cleaner, and rinse it after eating.',
        'Take it out at night to rest your gums. Keep it in water or denture solution so it does not dry out.',
        'Handle it over a folded towel or a basin of water, so it will not break if you drop it.',
        'A sore spot that does not heal within a few days, or a crack, needs a dentist. Do not try to adjust or repair it yourself.',
      ],
      es: [
        'Limpie su dentadura todos los días con un cepillo suave y jabón suave o limpiador para dentaduras, y enjuáguela después de comer.',
        'Quítesela por la noche para que descansen las encías. Guárdela en agua o en solución para dentaduras para que no se seque.',
        'Manéjela sobre una toalla doblada o un recipiente con agua, para que no se rompa si se le cae.',
        'Una llaga que no sana en unos días, o una grieta, necesita un dentista. No intente ajustarla ni repararla usted mismo.',
      ],
    },
    variants: {
      new: {
        en: ['New dentures take time to get used to. Start with soft foods cut into small pieces and chew on both sides at once. Speaking may feel strange at first; reading aloud helps.'],
        es: ['Acostumbrarse a una dentadura nueva lleva tiempo. Empiece con alimentos blandos cortados en trozos pequeños y mastique con los dos lados a la vez. Al principio puede sentir raro al hablar; leer en voz alta ayuda.'],
      },
      reline: {
        en: ['After a reline the fit will feel different for a few days, and mild soreness is common.'],
        es: ['Después de un rebase, el ajuste se sentirá diferente por unos días y es común una molestia leve.'],
      },
    },
  },
  deep_cleaning: {
    status: 'draft',
    title: { en: 'After a deep cleaning', es: 'Después de una limpieza profunda' },
    items: {
      en: [
        'Your gums may be sore and swollen, and your teeth sensitive to cold, for several days.',
        'Rinse gently with warm salt water (half a teaspoon of salt in a cup of warm water) 2–3 times a day for the next few days.',
        'Brush gently with a soft toothbrush and keep cleaning between your teeth — it helps your gums heal.',
        'Bleeding should lessen day by day. Swelling that gets worse, or a fever, is not normal: call {phone}.',
      ],
      es: [
        'Sus encías pueden estar adoloridas e hinchadas, y sus dientes sensibles al frío, por varios días.',
        'Enjuáguese suavemente con agua tibia con sal (media cucharadita de sal en una taza de agua tibia) 2–3 veces al día durante los próximos días.',
        'Cepíllese con cuidado con un cepillo suave y siga limpiando entre los dientes: eso ayuda a sanar las encías.',
        'El sangrado debe disminuir día a día. Una hinchazón que empeora, o la fiebre, no son normales: llame al {phone}.',
      ],
    },
  },
  cleaning: {
    status: 'draft',
    title: { en: 'After your cleaning', es: 'Después de su limpieza' },
    items: {
      en: [
        'Your gums may be a little sore, or bleed slightly when you brush, for a day or two.',
        'Brush twice a day with fluoride toothpaste and clean between your teeth every day.',
        'If your gums keep bleeding for more than a week, see a dentist.',
      ],
      es: [
        'Sus encías pueden estar un poco adoloridas, o sangrar un poco al cepillarse, por uno o dos días.',
        'Cepíllese dos veces al día con pasta dental con flúor y limpie entre los dientes todos los días.',
        'Si sus encías siguen sangrando por más de una semana, vea a un dentista.',
      ],
    },
  },
  fluoride: {
    status: 'draft',
    title: { en: 'Fluoride treatment', es: 'Tratamiento con flúor' },
    items: {
      en: [
        'Fluoride was painted on your teeth. For the next 4–6 hours, eat soft foods and avoid hot drinks and hard or sticky foods.',
        'Do not brush or floss until tomorrow morning, so the fluoride can work.',
        'Your teeth may look yellow or feel fuzzy until you brush. This is normal.',
      ],
      es: [
        'Se le aplicó flúor en los dientes. Durante las próximas 4–6 horas, coma alimentos blandos y evite bebidas calientes y alimentos duros o pegajosos.',
        'No se cepille ni use hilo dental hasta mañana por la mañana, para que el flúor haga efecto.',
        'Sus dientes pueden verse amarillos o sentirse ásperos hasta que se cepille. Es normal.',
      ],
    },
  },
  sealant: {
    status: 'draft',
    title: { en: 'Sealants', es: 'Selladores' },
    items: {
      en: [
        'You can eat and drink normally.',
        'The sealant may feel a little rough at first. This usually wears smooth within a few days.',
        'Avoid chewing ice or hard candy, which can chip it.',
        'Keep brushing and cleaning between your teeth: sealants protect only the chewing surfaces.',
      ],
      es: [
        'Puede comer y beber normalmente.',
        'Al principio el sellador puede sentirse un poco áspero. Por lo general se alisa en unos días.',
        'Evite masticar hielo o dulces duros, porque pueden despostillarlo.',
        'Siga cepillándose y limpiando entre los dientes: los selladores protegen solo las superficies de masticar.',
      ],
    },
  },
  referral: {
    status: 'draft',
    title: { en: 'Care you still need: referral', es: 'Atención que aún necesita: remisión' },
    items: {
      en: [
        'The dentist recommends that you see: {to}.',
        'Tooth: #{tooth}.',
        'Reason (as written by the dentist): {reason}',
        'Take this sheet with you to that appointment.',
      ],
      es: [
        'El dentista le recomienda consultar a: {to}.',
        'Diente: #{tooth}.',
        'Motivo (como lo escribió el dentista): {reason}',
        'Lleve esta hoja a esa cita.',
      ],
    },
    variants: {
      routine: { en: ['Make an appointment when you can.'], es: ['Haga una cita cuando pueda.'] },
      soon: { en: ['Please make an appointment soon, within the next few weeks.'], es: ['Por favor, haga una cita pronto, en las próximas semanas.'] },
      urgent: {
        en: ['This is urgent: please be seen as soon as possible. If you have swelling that is spreading, a fever, or trouble breathing or swallowing, go to the Emergency Room.'],
        es: ['Esto es urgente: por favor, busque atención lo antes posible. Si tiene hinchazón que se extiende, fiebre, o dificultad para respirar o tragar, vaya a la sala de emergencias.'],
      },
      // A destination this sheet cannot name: "Other" ticked with nothing
      // typed, or a key from a newer station's list.
      unnamed: {
        en: ['Before you leave today, ask the dental team which provider to see.'],
        es: ['Antes de irse hoy, pregunte al equipo dental a qué proveedor debe consultar.'],
      },
    },
  },
  general: {
    status: 'draft',
    title: { en: 'If you have a problem', es: 'Si tiene algún problema' },
    items: {
      en: [
        'For swelling that keeps growing after 24–48 hours, or pain that is not relieved: call Mission Minded Worldwide at {phone} and leave a message. Someone will call you back and tell you how to get care. Please be patient and wait for the call.',
        'If you have difficulty breathing or swallowing, go to the nearest Emergency Room right away, or call 911.',
        'This follow-up help is only for the treatment you received today, not for other teeth. Mission Minded Worldwide does not pay for emergency room care; it pays only for a follow-up visit with an approved local dentist for infection, pain or swelling from today’s treatment.',
        'For any other dental care, see a local dentist, health department or community clinic.',
      ],
      es: [
        'Si tiene hinchazón que sigue creciendo después de 24–48 horas, o un dolor que no se alivia: llame a Mission Minded Worldwide al {phone} y deje un mensaje. Alguien le devolverá la llamada y le dirá cómo recibir atención. Por favor, tenga paciencia y espere la llamada.',
        'Si tiene dificultad para respirar o tragar, vaya de inmediato a la sala de emergencias más cercana o llame al 911.',
        'Esta ayuda de seguimiento es solo para el tratamiento que recibió hoy, no para otros dientes. Mission Minded Worldwide no paga la atención en la sala de emergencias; solo paga una consulta de seguimiento con un dentista local aprobado por infección, dolor o hinchazón causados por el tratamiento de hoy.',
        'Para cualquier otra atención dental, vea a un dentista local, al departamento de salud o a una clínica comunitaria.',
      ],
    },
  },
};

/* ========================== END EDITABLE BLOCK ========================== */

// The page's own words around the templates: the heading, and the note printed
// when the patient's language has no template yet (always in English, since
// that is the language the page then falls back to).
const PAGE_TEXT = {
  en: { title: 'After-Care Instructions', patient: 'Patient', dob: 'Date of birth', copy: 'Patient copy', printed: 'Printed' },
  es: { title: 'Instrucciones de cuidado', patient: 'Paciente', dob: 'Fecha de nacimiento', copy: 'Copia del paciente', printed: 'Impreso' },
};
const LANGUAGE_NAMES = { en: 'English', es: 'Spanish', ru: 'Russian', bzj: 'Belizean Creole (Kriol)', nya: 'Nyanja (Chinyanja)' };

const ORDER = Object.keys(TEMPLATES);

/* ---------------- reading a treatment row, whatever its age ---------------- */

// Reads a column that may still be the stored JSON string (a raw row) or
// already parsed (db.getPatient), and never throws on a damaged value.
function parsed(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string') return v;
  try { const out = JSON.parse(v); return out == null ? fallback : out; } catch (_) { return fallback; }
}
const text = (v) => (v == null ? '' : String(v).trim());
// Services counts were stored as strings ('' and '0' mean not done).
const count = (v) => { const n = Number(text(v)); return Number.isFinite(n) && n > 0; };

// Extraction types that mean more than a simple extraction (keys from
// provider.js EXTRACTION_TYPES; 'type' is how an early build stored one).
const SURGICAL_TYPES = ['surgical', 'impact_bony', 'impact_soft', 'root_tip'];
// Cleaning keys that are notes ABOUT a cleaning, not a cleaning — the rule the
// report counters (db.didCleaning) and the printed record share.
const CLEANING_NOTES = ['teeth', 'quad_detail'];
// Each option on the cleaning card (provider.js and hygienist.js CLEANING_OPTS,
// plus the early keys 'scaling' and 'fluoride') and the section it calls for.
// A sealant or a fluoride varnish on its own is not a cleaning, and a child who
// had only sealants must not be told their gums may bleed after one. Oral
// hygiene instruction is advice given, not a procedure with after-care. A key
// this build does not know — an option added on a newer station — is read as a
// cleaning, so a patient is never left with nothing for it. The harness pins
// every option on both screens to this map.
const CLEANING_SECTIONS = {
  adult_prophy: 'cleaning',
  quad_deep_scaling: 'deep_cleaning', gross_debridement: 'deep_cleaning', scaling: 'deep_cleaning',
  adult_fluoride: 'fluoride', fluoride: 'fluoride',
  sealant: 'sealant',
  ohi: null,
};
const cleaningSection = (k) => (Object.prototype.hasOwnProperty.call(CLEANING_SECTIONS, k) ? CLEANING_SECTIONS[k] : 'cleaning');

/**
 * What was performed, from the treatment row. Legacy-tolerant: an anaesthetic
 * stored as an object keyed by agent, an extraction's single `type`, the early
 * cleaning keys 'fluoride' and 'scaling', services counts as strings, and
 * restorative / services / referral_out that are missing, '{}' or damaged.
 *
 * Keyed ONLY on what the dentist recorded as done. The visit type chosen at
 * check-in and the oral-surgery consent are PLANNED care, and a patient who was
 * booked for an extraction but had a filling must not be sent home with
 * extraction instructions.
 */
function classify(t) {
  const out = { keys: [], variants: {}, values: {} };
  if (!t || typeof t !== 'object') return out;
  // A variant is only ever one the template defines — a stored value such as
  // an unknown urgency must not select anything (or reach Object.prototype).
  const on = (key, variant) => {
    if (!out.keys.includes(key)) out.keys.push(key);
    const defined = variant && TEMPLATES[key].variants && Object.prototype.hasOwnProperty.call(TEMPLATES[key].variants, variant);
    if (!defined) return;
    out.variants[key] = out.variants[key] || [];
    if (!out.variants[key].includes(variant)) out.variants[key].push(variant);
  };

  const extractions = parsed(t.extractions, []);
  const fillings = parsed(t.fillings, []);
  const cleaning = parsed(t.cleaning, {}) || {};
  const anesthetic = parsed(t.anesthetic, []);
  const restorative = parsed(t.restorative, {}) || {};
  const services = parsed(t.services, {}) || {};
  const referral = parsed(t.referral_out, null);

  // Any extraction with a tooth, or one written as "Other" text. An "other"
  // row with no tooth is not counted in the clinic's totals, but a patient who
  // had something taken out must still get the instructions — safety wins over
  // matching the report here. A bare {other: true} (an early build's marker,
  // with neither tooth nor text) says nothing was done.
  const exRows = (Array.isArray(extractions) ? extractions : []).filter((e) => e && typeof e === 'object');
  const didExtract = exRows.filter((e) => text(e.tooth) || (typeof e.other === 'string' && text(e.other)));
  if (didExtract.length) on('extraction');
  const surgical = didExtract.some((e) => (Array.isArray(e.types) ? e.types : (e.type ? [e.type] : []))
    .some((k) => SURGICAL_TYPES.includes(k)));
  if (surgical || count(services.alveoplasty)) { on('extraction'); on('extraction_surgical'); }

  // Anything the printed record lists as an anaesthetic administration.
  const anesRows = Array.isArray(anesthetic)
    ? anesthetic.filter((a) => a && typeof a === 'object')
    : Object.entries(anesthetic || {}).map(([k, v]) => ({ ...(v && typeof v === 'object' ? v : {}), agent: k }));
  const given = anesRows.filter((a) => text(a.agent) || text(a.name) || text(a.carps) || text(a.tooth) || text(a.location));
  if (given.length) on('anesthetic', given.some((a) => LONG_ACTING_ANESTHETICS.includes(a.agent)) ? 'long_acting' : null);

  const didFill = (Array.isArray(fillings) ? fillings : []).some((f) => f && text(f.tooth));
  const coreBuildup = !!(restorative.core_buildup && restorative.core_buildup.on);
  if (didFill || coreBuildup) on('filling', coreBuildup ? 'core_buildup' : null);
  if (count(services.irm)) on('temporary_filling');
  if ((restorative.recement && restorative.recement.on) || (restorative.bridge && restorative.bridge.on)) on('crown_bridge');
  if (count(services.pulpotomy)) on('pulpotomy');
  if (restorative.denture && restorative.denture.on) {
    on('denture', text(restorative.denture.action).toLowerCase());
  }

  const cleanKinds = new Set((cleaning && typeof cleaning === 'object' ? Object.entries(cleaning) : [])
    .filter(([k, v]) => v && !CLEANING_NOTES.includes(k)).map(([k]) => cleaningSection(k)).filter(Boolean));
  if (cleanKinds.has('deep_cleaning')) on('deep_cleaning');
  // A deep cleaning's own advice covers a cleaning; printing both would repeat it.
  else if (cleanKinds.has('cleaning')) on('cleaning');
  if (cleanKinds.has('fluoride')) on('fluoride');
  if (cleanKinds.has('sealant')) on('sealant');

  // The outbound clinical referral (treatments.referral_out) — only when it
  // sends the patient somewhere, the rule every other reader of it uses.
  const r = referral && typeof referral === 'object' ? referral : null;
  const to = r ? (Array.isArray(r.to) ? r.to : []) : [];
  if (r && (to.length || text(r.to_other))) {
    // Urgency is matched as the screen stores it (lower case); a row that
    // arrived as 'Urgent' must still carry the Emergency Room line.
    on('referral', text(r.urgency).toLowerCase());
    if (!referralNamed(r).complete) on('referral', 'unnamed');
    out.values.referral = r;
  }

  out.keys.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return out;
}

/** The procedure keys for a treatment row, in print order ('general' excluded). */
function aftercareKeys(t) {
  return classify(t).keys;
}

// The destinations this sheet can name, in the patient's language, from the
// same list the dentist picks from (src/main/dentalLabels.js mirrors it), and
// "Other" only once something was typed for it. A patient's sheet never says
// "see: Other." or prints a raw key — one from a newer station's list, or a
// damaged value — so those are left out, and `complete` is false so the sheet
// adds the line telling the patient to ask where to go.
function referralNamed(r, lang = 'en') {
  const to = Array.isArray(r.to) ? r.to : [];
  const names = [];
  let complete = true;
  for (const k of to) {
    if (k === 'other') continue;
    const hit = DL.DENTAL_REFERRAL_TO.find((x) => x.key === k);
    if (hit) names.push(hit[lang] || hit.en); else complete = false;
  }
  const other = text(r.to_other);
  if (other) names.push(other);
  else if (to.includes('other')) complete = false;
  return { names, complete };
}

function referralValues(r, lang) {
  return { to: referralNamed(r, lang).names.join(', '), tooth: text(r.tooth), reason: text(r.reason) };
}

function fill(line, values) {
  let empty = false;
  const s = line.replace(/\{(\w+)\}/g, (m, k) => {
    const v = k === 'phone' ? CONTACT.phone : values[k];
    if (v == null || v === '') { empty = true; return ''; }
    return String(v);
  });
  return empty ? null : s;
}

// Statuses in which the patient has not yet been at a treatment chair: waiting
// for Vitals or for Dental Triage, or examined at Dental Triage and parked in
// Treatment Waiting. A treatment row can already exist then, but it is the
// dentist's CHART, not care done — tagging a tooth on the odontogram writes the
// extraction or filling row, and "Move Patient to Treatment Waiting" saves it.
const NOT_YET_TREATED = ['checked_in', 'triaged', 'treatment_waiting'];

// The same stages as the triage row records them. The row is Dental Triage's
// track of the visit, and it is the only one that survives check-out: checking
// a patient out — at the desk or by an administrator — changes the patient's
// status and never this. A treatment save moves it to 'in_treatment' (and
// completing to 'completed'); until then it reads 'waiting' (not yet signed off
// by Vitals, or sent back to Vitals or the front desk by an administrator, which
// resets it), 'ready' (waiting for Dental Triage, or sent back to it to be
// examined again) or 'treatment_waiting' (parked for a chair). 'triaged' is a
// patient status and never written here; it is listed so a row that somehow
// carries it is not read as treated.
const TRIAGE_NOT_YET_TREATED = ['waiting', 'ready', 'triaged', 'treatment_waiting'];

/**
 * Where the visit stands, as far as after-care is concerned — the status is
 * part of the rule, because the treatment row alone cannot tell planned care
 * from care done:
 *   'treated'      the visit was marked complete (now or before an admin moved
 *                  the patient on), or the patient was checked out after being
 *                  taken into treatment (the triage row still says so): the row
 *                  is what was done
 *   'in_progress'  in treatment now (in_treatment): the row is being written
 *                  as the work is done, and is what has been charted so far
 *   'not_treated'  not yet at a chair (NOT_YET_TREATED), or checked out from
 *                  anywhere before one (TRIAGE_NOT_YET_TREATED on the triage
 *                  row) — the row is read as a plan, and after-care for it is
 *                  held back. That is a rule for what to withhold, not a
 *                  finding that nothing was done (see Limits): the printed
 *                  record heads such a chart "not confirmed as performed"
 *                  (pdf.js chartHeading), never "not performed"
 *   'none'         no treatment row at all
 * Check-out is not proof of treatment: the desk can check out anyone past
 * Vitals, and an administrator anyone at all.
 *
 * A status this build does not know (a newer station's) is read as in
 * progress, and one on the triage row of a checked-out patient as treated, so
 * care that was done is never withheld for want of a word. A progress save at
 * Dental Triage is in treatment too: a triage dentist can treat there, and the
 * row cannot tell a chart from work done at the same station.
 *
 * Limits, all on the safe side (the general advice still prints, and the
 * check-out desk is told why): a cleaning the hygienist saved for a patient
 * still waiting for a chair is not printed until they are treated — the row
 * cannot tell it from a cleaning Dental Triage only charted; and a patient
 * taken into treatment, then sent back by an administrator and checked out
 * from there without the visit being completed, reads as not treated, because
 * the move resets the triage row and nothing else records that work began.
 * (The hygienist's station never completes the visit of a patient waiting for
 * a chair — db.hygienistFinalize keeps them waiting — so a completed visit is
 * never a cleaning finished around a chart nobody treated.)
 */
function careStage(p) {
  const patient = p || {};
  const t = patient.treatment;
  if (!t) return 'none';
  const st = text(patient.status);
  // A visit once marked complete keeps its record of what was done, even when
  // an administrator has since moved the patient back for more.
  if (st === 'completed' || text(t.completed_at)) return 'treated';
  if (st === 'dismissed') {
    // Where the patient had got to when they left. No triage row at all is a
    // record from before triage existed, whose row is what was done.
    const tr = patient.triage && typeof patient.triage === 'object' ? patient.triage : null;
    return tr && TRIAGE_NOT_YET_TREATED.includes(text(tr.status)) ? 'not_treated' : 'treated';
  }
  if (NOT_YET_TREATED.includes(st)) return 'not_treated';
  // In treatment — and a status this build does not know, which is read the
  // same way: the row as it stands, so care that was done is never withheld.
  return 'in_progress';
}

/**
 * The after-care for one patient, in one language:
 *   { version, status, lang, requested, fellBack, stage, keys, sections,
 *     appendToRecord, contact }
 * sections = [{ key, title, title_en, items, status }], 'general' last.
 *
 * `lang` defaults to the patient's own. A language with no templates falls
 * back to English (fellBack) — and the page says so.
 *
 * `stage` is careStage(p). Before treatment ('not_treated') the procedure
 * sections are left out whatever the row holds, so a patient who leaves before
 * a chair — waiting for one, or sent back to be seen again — is never sent home
 * with instructions for surgery that did not happen; only the general advice
 * prints.
 *
 * appendToRecord is the rule for the visit summary and full record: once the
 * visit is treated, or mid-treatment when something is already recorded —
 * never before treatment. It keeps the page off a record printed before the
 * chair (the check-in USB, the summary from the Vitals queue or from Dental
 * Triage), where it could only be empty or wrong. The standalone after-care
 * sheet always prints, with at least the 'general' section.
 */
function aftercareSections(p, lang) {
  const patient = p || {};
  const requested = text(lang || patient.language || 'en').toLowerCase() || 'en';
  const L = LANGS.includes(requested) ? requested : 'en';
  const t = patient.treatment || null;
  const stage = careStage(patient);
  const c = stage === 'not_treated' ? classify(null) : classify(t);
  const values = c.values.referral ? referralValues(c.values.referral, L) : {};
  const sections = [...c.keys, 'general'].map((key) => {
    const tpl = TEMPLATES[key];
    const lines = [...(tpl.items[L] || tpl.items.en)];
    (c.variants[key] || []).forEach((v) => {
      const extra = tpl.variants && tpl.variants[v];
      if (extra) lines.push(...(extra[L] || extra.en));
    });
    return {
      key,
      title: tpl.title[L] || tpl.title.en,
      title_en: tpl.title.en,
      items: lines.map((l) => fill(l, values)).filter(Boolean),
      status: tpl.status,
    };
  });
  return {
    version: AFTERCARE_VERSION,
    status: sections.every((s) => s.status === 'mmw') ? 'mmw' : 'draft',
    lang: L,
    requested,
    fellBack: L !== requested,
    stage,
    keys: c.keys,
    sections,
    appendToRecord: stage === 'treated' || (stage === 'in_progress' && c.keys.length > 0),
    contact: { ...CONTACT },
  };
}

module.exports = {
  AFTERCARE_VERSION, CONTACT, LONG_ACTING_ANESTHETICS, LANGS, TEMPLATES, PAGE_TEXT, LANGUAGE_NAMES,
  CLEANING_SECTIONS, NOT_YET_TREATED, TRIAGE_NOT_YET_TREATED,
  classify, aftercareKeys, aftercareSections, careStage,
};
