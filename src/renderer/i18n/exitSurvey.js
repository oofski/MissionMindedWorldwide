// The MMW Patient Exit Survey, as data.
//
// One source of truth for three consumers: the form the patient fills in at
// check-out, the labels the Reports tab puts on the aggregate counts, and the
// printed/exported copy. A question that exists in one place and not another is
// how a grant return ends up unable to explain its own numbers.
//
// Question order and option wording follow the printed survey exactly, so a
// paper form filled in at a busy clinic can be typed up afterwards without
// anyone having to decide what a given tick meant.
//
// Shape:
//   key      stable identifier — stored in the answers blob, NEVER renamed:
//            renaming one silently orphans every answer already collected
//   type     'single' (one choice) | 'multi' (select all that apply)
//   en / es  question text
//   options  [{ value, en, es }] — `value` is stored, the text is display only
//
// `value` is an English-ish slug rather than an index so a stored answer stays
// readable in an export and survives options being reordered.

export const SURVEY_VERSION = 'mmw-exit-v1';

// WHEN each section can honestly be asked.
//
// The survey is split across the visit. Everything about the patient's
// circumstances — household, income, insurance, housing, barriers to care — is
// answerable the moment they register, while they are sitting and waiting
// anyway. Everything about the visit itself can only be answered afterwards:
// nobody can rate care they have not yet received, and asking them to would
// produce a grant figure that means nothing.
//
// Splitting it also makes check-out a twelve-question ask instead of
// thirty-four, which is the difference between a survey people finish on their
// way out of the door and one they abandon.
export const STAGES = { REGISTRATION: 'registration', EXIT: 'exit' };

/** Shorthand for the answer sets that repeat across the survey. */
const YES_NO_UNSURE_PNA = [
  { value: 'yes', en: 'Yes', es: 'Sí' },
  { value: 'no', en: 'No', es: 'No' },
  { value: 'unsure', en: 'Unsure', es: 'No estoy seguro/a' },
  { value: 'pna', en: 'Prefer not to answer', es: 'Prefiero no responder' },
];
const YES_NO_PNA = [
  { value: 'yes', en: 'Yes', es: 'Sí' },
  { value: 'no', en: 'No', es: 'No' },
  { value: 'pna', en: 'Prefer not to answer', es: 'Prefiero no responder' },
];
const PNA = { value: 'pna', en: 'Prefer not to answer', es: 'Prefiero no responder' };

export const SECTIONS = [
  {
    key: 'about',
    stage: 'registration',
    en: 'About your visit',
    es: 'Sobre su visita',
    questions: [
      {
        key: 'first_time', type: 'single',
        en: 'Is this your first time receiving services from a free community health clinic?',
        es: '¿Es esta la primera vez que recibe servicios en una clínica comunitaria gratuita?',
        options: [
          { value: 'yes', en: 'Yes', es: 'Sí' },
          { value: 'no', en: 'No', es: 'No' },
          { value: 'not_sure', en: 'Not sure', es: 'No estoy seguro/a' },
        ],
      },
      {
        key: 'heard_about', type: 'single',
        en: 'How did you hear about this clinic?',
        es: '¿Cómo se enteró de esta clínica?',
        options: [
          { value: 'friend_family', en: 'Friend or family member', es: 'Un amigo o familiar' },
          { value: 'church', en: 'Church', es: 'La iglesia' },
          { value: 'social_media', en: 'Social media', es: 'Redes sociales' },
          { value: 'flyer', en: 'Flyer or poster', es: 'Un volante o cartel' },
          { value: 'community_org', en: 'Community organization', es: 'Una organización comunitaria' },
          { value: 'healthcare_provider', en: 'Healthcare provider', es: 'Un proveedor de salud' },
          { value: 'previous_mmw', en: 'Previous MMW clinic', es: 'Una clínica anterior de MMW' },
        ],
      },
    ],
  },
  {
    key: 'household',
    stage: 'registration',
    en: 'Your household',
    es: 'Su hogar',
    questions: [
      {
        key: 'household_size', type: 'single',
        en: 'How many people live in your household, including yourself?',
        es: '¿Cuántas personas viven en su hogar, incluyéndose a usted?',
        options: [
          { value: '1', en: '1', es: '1' },
          { value: '2', en: '2', es: '2' },
          { value: '3', en: '3', es: '3' },
          { value: '4', en: '4', es: '4' },
          { value: '5', en: '5', es: '5' },
          { value: '6_or_more', en: '6 or more', es: '6 o más' },
        ],
      },
      {
        key: 'children_under_18', type: 'single',
        en: 'How many children under 18 live in your household?',
        es: '¿Cuántos niños menores de 18 años viven en su hogar?',
        options: [
          { value: 'none', en: 'None', es: 'Ninguno' },
          { value: '1', en: '1', es: '1' },
          { value: '2', en: '2', es: '2' },
          { value: '3', en: '3', es: '3' },
          { value: '4_or_more', en: '4 or more', es: '4 o más' },
          PNA,
        ],
      },
      {
        key: 'disability', type: 'single',
        en: 'Do you or anyone in your household have a disability?',
        es: '¿Usted o alguien en su hogar tiene una discapacidad?',
        options: YES_NO_UNSURE_PNA,
      },
      {
        key: 'living_situation', type: 'single',
        en: 'What is your current living situation?',
        es: '¿Cuál es su situación de vivienda actual?',
        options: [
          { value: 'own', en: 'Own my home', es: 'Soy dueño/a de mi casa' },
          { value: 'rent', en: 'Rent my home or apartment', es: 'Rento mi casa o apartamento' },
          { value: 'with_family', en: 'Live with family or friends', es: 'Vivo con familiares o amigos' },
          { value: 'temporary', en: 'Temporary housing', es: 'Vivienda temporal' },
          { value: 'shelter', en: 'Shelter', es: 'Un albergue' },
          { value: 'homeless', en: 'Homeless or without stable housing', es: 'Sin hogar o sin vivienda estable' },
          PNA,
        ],
      },
      {
        key: 'education', type: 'single',
        en: 'What is the highest level of education you have completed?',
        es: '¿Cuál es el nivel de estudios más alto que ha completado?',
        options: [
          { value: 'none', en: 'No formal education', es: 'Sin educación formal' },
          { value: 'elementary', en: 'Elementary school', es: 'Escuela primaria' },
          { value: 'some_high_school', en: 'Some high school', es: 'Algo de escuela secundaria' },
          { value: 'high_school', en: 'High school diploma or GED', es: 'Diploma de secundaria o GED' },
          { value: 'some_college', en: 'Some college', es: 'Algo de universidad' },
          { value: 'associate', en: 'Associate degree', es: 'Título asociado' },
          { value: 'bachelor', en: "Bachelor's degree", es: 'Licenciatura' },
          { value: 'graduate', en: 'Graduate or professional degree', es: 'Posgrado o título profesional' },
          PNA,
        ],
      },
      {
        key: 'household_in_school', type: 'single',
        en: 'Does anyone in your household currently attend school or a training program?',
        es: '¿Alguien en su hogar asiste actualmente a la escuela o a un programa de capacitación?',
        options: YES_NO_PNA,
      },
    ],
  },
  {
    key: 'work',
    stage: 'registration',
    en: 'Work and income',
    es: 'Trabajo e ingresos',
    questions: [
      {
        key: 'employment', type: 'single',
        en: 'What is your current employment status?',
        es: '¿Cuál es su situación laboral actual?',
        options: [
          { value: 'full_time', en: 'Employed full-time', es: 'Empleado/a a tiempo completo' },
          { value: 'part_time', en: 'Employed part-time', es: 'Empleado/a a tiempo parcial' },
          { value: 'self_employed', en: 'Self-employed', es: 'Trabajo por cuenta propia' },
          { value: 'unable_to_work', en: 'Temporarily unable to work', es: 'Temporalmente sin poder trabajar' },
          { value: 'unemployed_looking', en: 'Unemployed and looking for work', es: 'Desempleado/a y buscando trabajo' },
          { value: 'unemployed_not_looking', en: 'Unemployed and not currently looking for work', es: 'Desempleado/a y no buscando trabajo actualmente' },
          { value: 'retired', en: 'Retired', es: 'Jubilado/a' },
          { value: 'student', en: 'Student', es: 'Estudiante' },
          { value: 'homemaker', en: 'Homemaker or caregiver', es: 'Ama/o de casa o cuidador/a' },
          PNA,
        ],
      },
      {
        key: 'work_type', type: 'single',
        en: 'If employed, what type of work do you do?',
        es: 'Si trabaja, ¿qué tipo de trabajo hace?',
        options: [
          { value: 'healthcare', en: 'Healthcare', es: 'Salud' },
          { value: 'education', en: 'Education', es: 'Educación' },
          { value: 'construction', en: 'Construction or skilled trades', es: 'Construcción u oficios especializados' },
          { value: 'retail', en: 'Retail or customer service', es: 'Ventas o servicio al cliente' },
          { value: 'food_service', en: 'Food service or hospitality', es: 'Servicio de alimentos u hotelería' },
          { value: 'transportation', en: 'Transportation', es: 'Transporte' },
          { value: 'agriculture', en: 'Agriculture', es: 'Agricultura' },
          { value: 'office', en: 'Office or professional services', es: 'Oficina o servicios profesionales' },
          PNA,
        ],
      },
      {
        key: 'income', type: 'single',
        en: 'What is your approximate annual household income before taxes?',
        es: '¿Cuál es aproximadamente el ingreso anual de su hogar antes de impuestos?',
        options: [
          { value: '0_15k', en: '$0–$15,000', es: '$0–$15,000' },
          { value: '15k_25k', en: '$15,001–$25,000', es: '$15,001–$25,000' },
          { value: '25k_35k', en: '$25,001–$35,000', es: '$25,001–$35,000' },
          { value: '35k_50k', en: '$35,001–$50,000', es: '$35,001–$50,000' },
          { value: '50k_75k', en: '$50,001–$75,000', es: '$50,001–$75,000' },
          { value: '75k_100k', en: '$75,001–$100,000', es: '$75,001–$100,000' },
          { value: 'over_100k', en: 'More than $100,000', es: 'Más de $100,000' },
          PNA,
        ],
      },
      {
        key: 'assistance', type: 'multi',
        en: 'Does your household currently receive any of the following forms of assistance?',
        es: '¿Su hogar recibe actualmente alguna de las siguientes formas de asistencia?',
        hintEn: 'Select all that apply.',
        hintEs: 'Seleccione todas las que correspondan.',
        options: [
          { value: 'snap', en: 'SNAP or food assistance', es: 'SNAP o asistencia alimentaria' },
          { value: 'medicaid', en: 'Medicaid', es: 'Medicaid' },
          { value: 'ssi', en: 'Supplemental Security Income (SSI)', es: 'Seguridad de Ingreso Suplementario (SSI)' },
          { value: 'ssdi', en: 'Social Security Disability Insurance (SSDI)', es: 'Seguro de Incapacidad del Seguro Social (SSDI)' },
          { value: 'housing', en: 'Housing assistance', es: 'Asistencia de vivienda' },
          { value: 'wic', en: 'WIC', es: 'WIC' },
          { value: 'other_public', en: 'Other public assistance', es: 'Otra asistencia pública' },
          { value: 'none', en: 'No assistance', es: 'Ninguna asistencia' },
          PNA,
        ],
      },
    ],
  },
  {
    key: 'coverage',
    stage: 'registration',
    en: 'Insurance and access to care',
    es: 'Seguro y acceso a la atención',
    questions: [
      {
        key: 'health_insurance', type: 'single',
        en: 'Do you currently have health insurance?',
        es: '¿Tiene actualmente seguro médico?',
        options: YES_NO_UNSURE_PNA,
      },
      {
        key: 'health_insurance_type', type: 'single',
        en: 'If you have health insurance, what type is it?',
        es: 'Si tiene seguro médico, ¿de qué tipo es?',
        options: [
          { value: 'employer', en: 'Employer-sponsored insurance', es: 'Seguro a través del empleador' },
          { value: 'medicaid', en: 'Medicaid', es: 'Medicaid' },
          { value: 'medicare', en: 'Medicare', es: 'Medicare' },
          { value: 'private', en: 'Private', es: 'Privado' },
          { value: 'military_va', en: 'Military or Veterans Affairs coverage', es: 'Cobertura militar o de Asuntos de Veteranos' },
          PNA,
          { value: 'na', en: 'Not applicable', es: 'No aplica' },
        ],
      },
      {
        key: 'dental_insurance', type: 'single',
        en: 'Do you currently have dental insurance?',
        es: '¿Tiene actualmente seguro dental?',
        options: YES_NO_UNSURE_PNA,
      },
      {
        key: 'vision_insurance', type: 'single',
        en: 'Do you currently have vision insurance?',
        es: '¿Tiene actualmente seguro de la vista?',
        options: YES_NO_UNSURE_PNA,
      },
      {
        key: 'last_checkup', type: 'single',
        en: 'When was the last time you received a medical checkup?',
        es: '¿Cuándo fue la última vez que tuvo un chequeo médico?',
        options: [
          { value: 'under_6m', en: 'Within the past 6 months', es: 'En los últimos 6 meses' },
          { value: '6_12m', en: '6–12 months ago', es: 'Hace 6–12 meses' },
          { value: '1_2y', en: '1–2 years ago', es: 'Hace 1–2 años' },
          { value: 'over_2y', en: 'More than 2 years ago', es: 'Hace más de 2 años' },
          { value: 'never', en: 'I have never received a medical checkup', es: 'Nunca he tenido un chequeo médico' },
          PNA,
        ],
      },
      {
        key: 'last_eye_exam', type: 'single',
        en: 'When was the last time you had an eye examination?',
        es: '¿Cuándo fue la última vez que tuvo un examen de la vista?',
        options: [
          { value: 'under_6m', en: 'Within the past 6 months', es: 'En los últimos 6 meses' },
          { value: '6_12m', en: '6–12 months ago', es: 'Hace 6–12 meses' },
          { value: '1_2y', en: '1–2 years ago', es: 'Hace 1–2 años' },
          { value: 'over_2y', en: 'More than 2 years ago', es: 'Hace más de 2 años' },
          { value: 'never', en: 'I have never had an eye examination', es: 'Nunca he tenido un examen de la vista' },
          PNA,
        ],
      },
      {
        key: 'delayed_care_cost', type: 'single',
        en: 'In the past 12 months, have you delayed or avoided healthcare because of cost?',
        es: 'En los últimos 12 meses, ¿ha retrasado o evitado atención médica por el costo?',
        options: YES_NO_PNA,
      },
      {
        key: 'access_barriers', type: 'multi',
        en: 'What are the main reasons you have difficulty accessing healthcare?',
        es: '¿Cuáles son las razones principales por las que tiene dificultad para acceder a atención médica?',
        hintEn: 'Select all that apply.',
        hintEs: 'Seleccione todas las que correspondan.',
        options: [
          { value: 'cost', en: 'Cost of services', es: 'El costo de los servicios' },
          { value: 'no_insurance', en: 'No insurance', es: 'No tengo seguro' },
          { value: 'high_deductible', en: 'High insurance deductible or copay', es: 'Deducible o copago alto del seguro' },
          { value: 'transportation', en: 'Lack of transportation', es: 'Falta de transporte' },
          { value: 'no_providers', en: 'Lack of nearby providers', es: 'Falta de proveedores cercanos' },
          { value: 'wait_times', en: 'Long waiting times', es: 'Tiempos de espera largos' },
          { value: 'work_schedule', en: 'Work schedule', es: 'Mi horario de trabajo' },
          { value: 'childcare', en: 'Childcare responsibilities', es: 'Responsabilidades de cuidado de niños' },
          { value: 'language', en: 'Language barriers', es: 'Barreras de idioma' },
          { value: 'no_new_patients', en: 'Difficulty finding a provider accepting new patients', es: 'Dificultad para encontrar un proveedor que acepte pacientes nuevos' },
          { value: 'none', en: 'No difficulty accessing healthcare', es: 'Ninguna dificultad para acceder a atención médica' },
          PNA,
        ],
      },
      {
        key: 'unmet_need', type: 'single',
        en: "Before today's clinic, did you have an unmet dental, medical, or vision need?",
        es: 'Antes de la clínica de hoy, ¿tenía una necesidad dental, médica o de la vista sin atender?',
        options: YES_NO_UNSURE_PNA,
      },
      {
        key: 'food_insecurity', type: 'single',
        en: 'In the past 12 months, have you had difficulty obtaining enough food for yourself or your household?',
        es: 'En los últimos 12 meses, ¿ha tenido dificultad para conseguir suficiente comida para usted o su hogar?',
        options: YES_NO_PNA,
      },
    ],
  },
  {
    key: 'experience',
    stage: 'exit',
    en: "Today's clinic",
    es: 'La clínica de hoy',
    questions: [
      {
        key: 'rate_care', type: 'single',
        en: 'How would you rate the quality of care you received today?',
        es: '¿Cómo calificaría la calidad de la atención que recibió hoy?',
        options: [
          { value: '1', en: '1 — Very poor', es: '1 — Muy mala' },
          { value: '2', en: '2 — Poor', es: '2 — Mala' },
          { value: '3', en: '3 — Fair', es: '3 — Regular' },
          { value: '4', en: '4 — Good', es: '4 — Buena' },
          { value: '5', en: '5 — Excellent', es: '5 — Excelente' },
        ],
      },
      {
        key: 'rate_staff', type: 'single',
        en: 'How would you rate the friendliness and respect shown by the volunteers and staff?',
        es: '¿Cómo calificaría la amabilidad y el respeto del personal y los voluntarios?',
        options: [
          { value: '1', en: 'Very poor', es: 'Muy malos' },
          { value: '2', en: 'Poor', es: 'Malos' },
          { value: '3', en: 'Fair', es: 'Regulares' },
          { value: '4', en: 'Good', es: 'Buenos' },
          { value: '5', en: 'Excellent', es: 'Excelentes' },
        ],
      },
      {
        key: 'rate_wait', type: 'single',
        en: 'How satisfied were you with the time you spent waiting?',
        es: '¿Qué tan satisfecho/a quedó con el tiempo que esperó?',
        options: [
          { value: '1', en: 'Very dissatisfied', es: 'Muy insatisfecho/a' },
          { value: '2', en: 'Dissatisfied', es: 'Insatisfecho/a' },
          { value: '3', en: 'Neutral', es: 'Neutral' },
          { value: '4', en: 'Satisfied', es: 'Satisfecho/a' },
          { value: '5', en: 'Very satisfied', es: 'Muy satisfecho/a' },
        ],
      },
      {
        key: 'comfortable_questions', type: 'single',
        en: 'Did you feel comfortable asking questions during your visit?',
        es: '¿Se sintió cómodo/a haciendo preguntas durante su visita?',
        options: [
          { value: 'yes', en: 'Yes', es: 'Sí' },
          { value: 'no', en: 'No', es: 'No' },
          { value: 'somewhat', en: 'Somewhat', es: 'Más o menos' },
        ],
      },
      {
        key: 'explained_care', type: 'single',
        en: 'Did the healthcare team explain your care in a way you could understand?',
        es: '¿El equipo de salud le explicó su atención de una manera que pudo entender?',
        options: [
          { value: 'yes', en: 'Yes', es: 'Sí' },
          { value: 'no', en: 'No', es: 'No' },
          { value: 'somewhat', en: 'Somewhat', es: 'Más o menos' },
          { value: 'na', en: 'Not applicable', es: 'No aplica' },
        ],
      },
      {
        key: 'recommend', type: 'single',
        en: 'How likely are you to recommend Mission Minded Worldwide to someone who needs similar services?',
        es: '¿Qué tan probable es que recomiende Mission Minded Worldwide a alguien que necesite servicios similares?',
        options: [
          { value: '1', en: 'Very unlikely', es: 'Muy poco probable' },
          { value: '2', en: 'Unlikely', es: 'Poco probable' },
          { value: '3', en: 'Neutral', es: 'Neutral' },
          { value: '4', en: 'Likely', es: 'Probable' },
          { value: '5', en: 'Very likely', es: 'Muy probable' },
        ],
      },
    ],
  },
  {
    key: 'impact',
    stage: 'exit',
    en: 'The difference today made',
    es: 'La diferencia que hizo hoy',
    questions: [
      {
        key: 'health_concern_daily', type: 'single',
        en: "Before today's clinic, did you have a health concern that affected your daily activities?",
        es: 'Antes de la clínica de hoy, ¿tenía un problema de salud que afectaba sus actividades diarias?',
        options: YES_NO_UNSURE_PNA,
      },
      {
        key: 'will_improve_health', type: 'single',
        en: "Do you believe today's services will help improve your health in the future?",
        es: '¿Cree que los servicios de hoy ayudarán a mejorar su salud en el futuro?',
        options: [
          { value: 'yes', en: 'Yes', es: 'Sí' },
          { value: 'no', en: 'No', es: 'No' },
          { value: 'unsure', en: 'Unsure', es: 'No estoy seguro/a' },
        ],
      },
      {
        key: 'reduced_financial_burden', type: 'single',
        en: "Did today's services help reduce the financial burden of receiving healthcare?",
        es: '¿Los servicios de hoy ayudaron a reducir la carga económica de recibir atención médica?',
        options: YES_NO_UNSURE_PNA,
      },
      {
        key: 'available_elsewhere', type: 'single',
        en: 'Without this free clinic, would you have been able to obtain the same services elsewhere?',
        es: 'Sin esta clínica gratuita, ¿habría podido conseguir los mismos servicios en otro lugar?',
        options: YES_NO_UNSURE_PNA,
      },
      {
        key: 'future_needs', type: 'multi',
        en: 'What healthcare services do you or your household need in the future?',
        es: '¿Qué servicios de salud necesitarán usted o su hogar en el futuro?',
        hintEn: 'Select all that apply.',
        hintEs: 'Seleccione todas las que correspondan.',
        options: [
          { value: 'dental', en: 'Dental care', es: 'Atención dental' },
          { value: 'medical', en: 'Medical care', es: 'Atención médica' },
          { value: 'vision', en: 'Vision care', es: 'Atención de la vista' },
          { value: 'prescriptions', en: 'Prescription medications', es: 'Medicamentos recetados' },
          { value: 'mental_health', en: 'Mental health services', es: 'Servicios de salud mental' },
          { value: 'screenings', en: 'Preventive screenings', es: 'Exámenes preventivos' },
          { value: 'health_education', en: 'Health education', es: 'Educación sobre la salud' },
          { value: 'none', en: 'None', es: 'Ninguno' },
        ],
      },
      {
        key: 'future_interest', type: 'single',
        en: 'Would you be interested in participating in future Mission Minded Worldwide clinics?',
        es: '¿Le interesaría participar en futuras clínicas de Mission Minded Worldwide?',
        options: [
          { value: 'yes', en: 'Yes', es: 'Sí' },
          { value: 'no', en: 'No', es: 'No' },
          { value: 'maybe', en: 'Maybe', es: 'Tal vez' },
        ],
      },
    ],
  },
];

/** The sections asked at each point in the visit. */
export const REGISTRATION_SECTIONS = SECTIONS.filter((s) => s.stage === STAGES.REGISTRATION);
export const EXIT_SECTIONS = SECTIONS.filter((s) => s.stage === STAGES.EXIT);

/** Questions belonging to one stage — used to score that stage's completeness. */
export function questionsForStage(stage) {
  return SECTIONS.filter((s) => s.stage === stage).flatMap((s) => s.questions);
}

/** Every question, flattened — the order the survey is asked and reported in. */
export const QUESTIONS = SECTIONS.flatMap((s) => s.questions.map((q) => ({ ...q, section: s.key })));

/** Look-ups used by the form, the reports tab and the PDF. */
export const QUESTION_BY_KEY = Object.fromEntries(QUESTIONS.map((q) => [q.key, q]));

/** Display text for a stored value, falling back to the raw value. */
export function optionLabel(questionKey, value, lang = 'en') {
  const q = QUESTION_BY_KEY[questionKey];
  if (!q) return String(value);
  const o = q.options.find((x) => x.value === value);
  if (!o) return String(value);
  return o[lang] || o.en;
}
