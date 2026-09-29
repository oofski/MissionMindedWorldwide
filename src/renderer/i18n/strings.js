// Bilingual string catalogue. English ships complete; Spanish covers the
// patient-facing intake + consents (staff screens fall back to English).
// Additional language packs can be added here without touching app code.

export const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'ru', label: 'Russian', native: 'Русский' },
  { code: 'bzj', label: 'Belizean Creole', native: 'Kriol' },
  { code: 'nya', label: 'Nyanja', native: 'Chinyanja' },
];

// "How did you hear about us?" dropdown options (F4).
export const REFERRALS = [
  { key: 'email', en: 'Email', es: 'Correo electrónico', ru: 'Электронная почта' },
  { key: 'text', en: 'Text message', es: 'Mensaje de texto', ru: 'СМС' },
  { key: 'sign', en: 'Sign / banner', es: 'Letrero / pancarta', ru: 'Вывеска / баннер' },
  { key: 'friend_referral', en: 'Friend / referral', es: 'Amigo / referencia', ru: 'Друг / рекомендация' },
  { key: 'flyer', en: 'Flyer', es: 'Volante', ru: 'Листовка' },
  { key: 'church', en: 'Church / community', es: 'Iglesia / comunidad', ru: 'Церковь / община' },
  { key: 'social_media', en: 'Social media', es: 'Redes sociales', ru: 'Соцсети' },
  { key: 'other', en: 'Other', es: 'Otro', ru: 'Другое' },
];

// Medical-history conditions. `flag:true` items raise a clinical alert for the
// dentist; `intake` (default true) marks the ones asked at check-in.
//
// The intake set is Dr. Trinh's top-25 form (v0.0.15), in his order and in his
// wording, each answered Yes / No / Unsure. Eighteen keys are the ones the
// older 30-item checklist already used for the same thing, so a record taken
// before this change still reads under the new label with no migration.
//
// The keys his form retired stay below with intake:false and their OLD label
// and flag. A record that ticked "Heart murmur" must still show "Heart murmur"
// on every screen and export, and a kept report that counted it must still be
// able to name it — dropping the entry would hide a logged condition.
export const CONDITIONS = [
  { key: 'high_bp', flag: true, en: 'High Blood Pressure (Hypertension)', es: 'Presión arterial alta (hipertensión)' },
  { key: 'diabetes', flag: true, en: 'Diabetes – Type 1 or Type 2', es: 'Diabetes – tipo 1 o tipo 2' },
  { key: 'heart_disease', flag: true, en: 'Heart Disease / Coronary Artery Disease', es: 'Enfermedad del corazón / enfermedad de las arterias coronarias' },
  { key: 'heart_attack', flag: true, en: 'Heart Attack / Myocardial Infarction', es: 'Ataque al corazón / infarto de miocardio' },
  { key: 'stroke', flag: true, en: 'Stroke / TIA', es: 'Derrame cerebral / accidente isquémico transitorio (AIT)' },
  { key: 'high_cholesterol', flag: false, en: 'High Cholesterol', es: 'Colesterol alto' },
  { key: 'asthma', flag: false, en: 'Asthma', es: 'Asma' },
  { key: 'copd', flag: false, en: 'COPD / Emphysema / Chronic Lung Disease', es: 'EPOC / enfisema / enfermedad pulmonar crónica' },
  { key: 'kidney', flag: false, en: 'Kidney Disease / Kidney Failure', es: 'Enfermedad renal / insuficiencia renal' },
  // Absorbs the retired "Hepatitis" item, which was a red flag, so this is one too.
  { key: 'liver', flag: true, en: 'Liver Disease / Hepatitis', es: 'Enfermedad del hígado / hepatitis' },
  { key: 'thyroid', flag: false, en: 'Thyroid Disease', es: 'Enfermedad de la tiroides' },
  { key: 'cancer', flag: false, en: 'Cancer / History of Cancer', es: 'Cáncer / antecedentes de cáncer' },
  { key: 'epilepsy', flag: true, en: 'Seizures / Epilepsy', es: 'Convulsiones / epilepsia' },
  { key: 'bleeding', flag: true, en: 'Bleeding Disorder / Excessive Bleeding', es: 'Trastorno de sangrado / sangrado excesivo' },
  { key: 'blood_clot', flag: true, en: 'Blood Clot / DVT / Pulmonary Embolism', es: 'Coágulo de sangre / TVP / embolia pulmonar' },
  { key: 'anemia', flag: false, en: 'Anemia / Blood Disorder', es: 'Anemia / trastorno de la sangre' },
  { key: 'arthritis', flag: false, en: 'Arthritis / Rheumatoid Arthritis', es: 'Artritis / artritis reumatoide' },
  // Flagged: bisphosphonates for bone loss are an extraction risk (MRONJ).
  { key: 'osteoporosis', flag: true, en: 'Osteoporosis / Bone Disease', es: 'Osteoporosis / enfermedad de los huesos' },
  { key: 'ulcers', flag: false, en: 'GERD / Acid Reflux / Stomach Ulcers', es: 'ERGE / reflujo ácido / úlceras estomacales' },
  { key: 'mental_health', flag: false, en: 'Depression / Anxiety / Other Mental Health Condition', es: 'Depresión / ansiedad / otra condición de salud mental' },
  { key: 'sleep_apnea', flag: false, en: 'Sleep Apnea', es: 'Apnea del sueño' },
  { key: 'tuberculosis', flag: true, en: 'Tuberculosis (TB) / History of TB', es: 'Tuberculosis (TB) / antecedentes de TB' },
  { key: 'hiv', flag: true, en: 'HIV/AIDS', es: 'VIH/SIDA' },
  { key: 'autoimmune', flag: false, en: 'Autoimmune / Immune System Disorder', es: 'Enfermedad autoinmune / trastorno del sistema inmunitario' },
  // The one question that is not about everyone who sits down at the kiosk, so
  // it alone also accepts "Not applicable" ("when applicable" on his form).
  { key: 'pregnant', flag: true, en: 'Pregnancy / Possible Pregnancy (when applicable)', es: 'Embarazo / posible embarazo (cuando aplique)' },
  // Retired from check-in (v0.0.15). Old labels and flags, kept for display.
  { key: 'heart_murmur', flag: true, en: 'Heart murmur', es: 'Soplo cardíaco', intake: false },
  { key: 'pacemaker', flag: true, en: 'Pacemaker', es: 'Marcapasos', intake: false },
  { key: 'artificial_valve', flag: true, en: 'Artificial heart valve', es: 'Válvula cardíaca artificial', intake: false },
  { key: 'rheumatic_fever', flag: false, en: 'Rheumatic fever', es: 'Fiebre reumática', intake: false },
  { key: 'hepatitis', flag: true, en: 'Hepatitis', es: 'Hepatitis', intake: false },
  { key: 'blood_thinners', flag: true, en: 'Takes blood thinners', es: 'Toma anticoagulantes', intake: false },
  { key: 'glaucoma', flag: false, en: 'Glaucoma', es: 'Glaucoma', intake: false },
  { key: 'respiratory', flag: false, en: 'Respiratory problems', es: 'Problemas respiratorios', intake: false },
  { key: 'latex', flag: true, en: 'Latex allergy', es: 'Alergia al látex', intake: false },
  { key: 'anesthesia_reaction', flag: true, en: 'Reaction to anesthesia', es: 'Reacción a la anestesia', intake: false },
  { key: 'pain_mgmt', flag: false, en: 'Pain management program', es: 'Programa de manejo del dolor', intake: false },
  { key: 'weight_mgmt', flag: false, en: 'Weight management program', es: 'Programa de manejo de peso', intake: false },
];

// The local anaesthetics MMW carries, with the concentrations on the carpule.
// Shared so the chairside agent picker and anything reporting on it cannot
// drift apart.
export const ANESTHETICS = [
  { key: 'lidocaine', en: 'Lidocaine 2%' },
  { key: 'articaine', en: 'Articaine 4%' },
  { key: 'mepivacaine', en: 'Mepivacaine 3%' },
  { key: 'bupivacaine', en: 'Bupivacaine 0.5%' },
  { key: 'prilocaine', en: 'Prilocaine 4%' },
];

// The antibiotics MMW carries. Used for the allergy list above; kept named here
// so the source of that list is obvious and one place changes both.
export const ANTIBIOTICS = [
  { key: 'amoxicillin', en: 'Amoxicillin' },
  { key: 'clindamycin', en: 'Clindamycin' },
  { key: 'penicillin_vk', en: 'Penicillin V potassium' },
  { key: 'azithromycin', en: 'Azithromycin' },
  { key: 'amoxicillin_clavulanate', en: 'Amoxicillin + clavulanate' },
];

// The 100 medications a patient is most likely to be taking, from MMW's own
// list. `rank` is that list's ordering — 1 is the most commonly prescribed — and
// the picker offers them in that order, so the handful of drugs most patients
// are on are the first things a volunteer sees.
//
// These are SUGGESTIONS, never a closed set. The picker accepts anything typed,
// because a patient on a drug outside this hundred must still be recordable: the
// provider reads this list before deciding what is safe to give them, and a
// medication that could not be entered is a medication nobody sees.
//
// Drug names are not translated — a brand or generic name is the same word in
// every language, and "translating" one would be a prescribing error.
export const MEDICATIONS = [
  { key: 'atorvastatin', rank: 1, name: 'Atorvastatin' },
  { key: 'levothyroxine', rank: 2, name: 'Levothyroxine' },
  { key: 'metformin', rank: 3, name: 'Metformin' },
  { key: 'amlodipine', rank: 4, name: 'Amlodipine' },
  { key: 'lisinopril', rank: 5, name: 'Lisinopril' },
  { key: 'albuterol', rank: 6, name: 'Albuterol' },
  { key: 'losartan', rank: 7, name: 'Losartan' },
  { key: 'metoprolol', rank: 8, name: 'Metoprolol' },
  { key: 'rosuvastatin', rank: 9, name: 'Rosuvastatin' },
  { key: 'omeprazole', rank: 10, name: 'Omeprazole' },
  { key: 'gabapentin', rank: 11, name: 'Gabapentin' },
  { key: 'sertraline', rank: 12, name: 'Sertraline' },
  { key: 'escitalopram', rank: 13, name: 'Escitalopram' },
  { key: 'semaglutide', rank: 14, name: 'Semaglutide' },
  { key: 'amphetamine_dextroamphetamine', rank: 15, name: 'Amphetamine/dextroamphetamine' },
  { key: 'pantoprazole', rank: 16, name: 'Pantoprazole' },
  { key: 'bupropion', rank: 17, name: 'Bupropion' },
  { key: 'hydrochlorothiazide', rank: 18, name: 'Hydrochlorothiazide' },
  { key: 'fluoxetine', rank: 19, name: 'Fluoxetine' },
  { key: 'trazodone', rank: 20, name: 'Trazodone' },
  { key: 'montelukast', rank: 21, name: 'Montelukast' },
  { key: 'amoxicillin', rank: 22, name: 'Amoxicillin' },
  { key: 'fluticasone', rank: 23, name: 'Fluticasone' },
  { key: 'tamsulosin', rank: 24, name: 'Tamsulosin' },
  { key: 'apixaban', rank: 25, name: 'Apixaban' },
  { key: 'simvastatin', rank: 26, name: 'Simvastatin' },
  { key: 'insulin_glargine', rank: 27, name: 'Insulin glargine' },
  { key: 'empagliflozin', rank: 28, name: 'Empagliflozin' },
  { key: 'furosemide', rank: 29, name: 'Furosemide' },
  { key: 'meloxicam', rank: 30, name: 'Meloxicam' },
  { key: 'hydrocodone_acetaminophen', rank: 31, name: 'Hydrocodone/acetaminophen' },
  { key: 'tirzepatide', rank: 32, name: 'Tirzepatide' },
  { key: 'methylphenidate', rank: 33, name: 'Methylphenidate' },
  { key: 'duloxetine', rank: 34, name: 'Duloxetine' },
  { key: 'prednisone', rank: 35, name: 'Prednisone' },
  { key: 'carvedilol', rank: 36, name: 'Carvedilol' },
  { key: 'famotidine', rank: 37, name: 'Famotidine' },
  { key: 'ibuprofen', rank: 38, name: 'Ibuprofen' },
  { key: 'buspirone', rank: 39, name: 'Buspirone' },
  { key: 'venlafaxine', rank: 40, name: 'Venlafaxine' },
  { key: 'tramadol', rank: 41, name: 'Tramadol' },
  { key: 'potassium_chloride', rank: 42, name: 'Potassium chloride' },
  { key: 'hydroxyzine', rank: 43, name: 'Hydroxyzine' },
  { key: 'allopurinol', rank: 44, name: 'Allopurinol' },
  { key: 'clopidogrel', rank: 45, name: 'Clopidogrel' },
  { key: 'ergocalciferol', rank: 46, name: 'Ergocalciferol (Vitamin D2)' },
  { key: 'cetirizine', rank: 47, name: 'Cetirizine' },
  { key: 'ondansetron', rank: 48, name: 'Ondansetron' },
  { key: 'cyclobenzaprine', rank: 49, name: 'Cyclobenzaprine' },
  { key: 'spironolactone', rank: 50, name: 'Spironolactone' },
  { key: 'oxycodone', rank: 51, name: 'Oxycodone' },
  { key: 'estradiol', rank: 52, name: 'Estradiol' },
  { key: 'aspirin', rank: 53, name: 'Aspirin' },
  { key: 'glipizide', rank: 54, name: 'Glipizide' },
  { key: 'zolpidem', rank: 55, name: 'Zolpidem' },
  { key: 'lamotrigine', rank: 56, name: 'Lamotrigine' },
  { key: 'alprazolam', rank: 57, name: 'Alprazolam' },
  { key: 'citalopram', rank: 58, name: 'Citalopram' },
  { key: 'pregabalin', rank: 59, name: 'Pregabalin' },
  { key: 'cholecalciferol', rank: 60, name: 'Cholecalciferol (Vitamin D3)' },
  { key: 'clonazepam', rank: 61, name: 'Clonazepam' },
  { key: 'azithromycin', rank: 62, name: 'Azithromycin' },
  { key: 'pravastatin', rank: 63, name: 'Pravastatin' },
  { key: 'valsartan', rank: 64, name: 'Valsartan' },
  { key: 'ezetimibe', rank: 65, name: 'Ezetimibe' },
  { key: 'diclofenac', rank: 66, name: 'Diclofenac' },
  { key: 'insulin_lispro', rank: 67, name: 'Insulin lispro' },
  { key: 'ethinyl_estradiol_norethindrone', rank: 68, name: 'Ethinyl estradiol/norethindrone' },
  { key: 'propranolol', rank: 69, name: 'Propranolol' },
  { key: 'latanoprost', rank: 70, name: 'Latanoprost' },
  { key: 'atenolol', rank: 71, name: 'Atenolol' },
  { key: 'lisdexamfetamine', rank: 72, name: 'Lisdexamfetamine' },
  { key: 'doxycycline', rank: 73, name: 'Doxycycline' },
  { key: 'amoxicillin_clavulanate', rank: 74, name: 'Amoxicillin/clavulanate' },
  { key: 'dulaglutide', rank: 75, name: 'Dulaglutide' },
  { key: 'hydrochlorothiazide_lisinopril', rank: 76, name: 'Hydrochlorothiazide/lisinopril' },
  { key: 'lorazepam', rank: 77, name: 'Lorazepam' },
  { key: 'fluticasone_salmeterol', rank: 78, name: 'Fluticasone/salmeterol' },
  { key: 'insulin_aspart', rank: 79, name: 'Insulin aspart' },
  { key: 'celecoxib', rank: 80, name: 'Celecoxib' },
  { key: 'finasteride', rank: 81, name: 'Finasteride' },
  { key: 'quetiapine', rank: 82, name: 'Quetiapine' },
  { key: 'clonidine', rank: 83, name: 'Clonidine' },
  { key: 'aripiprazole', rank: 84, name: 'Aripiprazole' },
  { key: 'cephalexin', rank: 85, name: 'Cephalexin' },
  { key: 'alendronate', rank: 86, name: 'Alendronate' },
  { key: 'topiramate', rank: 87, name: 'Topiramate' },
  { key: 'tizanidine', rank: 88, name: 'Tizanidine' },
  { key: 'dapagliflozin', rank: 89, name: 'Dapagliflozin' },
  { key: 'oxycodone_acetaminophen', rank: 90, name: 'Oxycodone/acetaminophen' },
  { key: 'hydrochlorothiazide_losartan', rank: 91, name: 'Hydrochlorothiazide/losartan' },
  { key: 'olmesartan', rank: 92, name: 'Olmesartan' },
  { key: 'testosterone', rank: 93, name: 'Testosterone' },
  { key: 'amitriptyline', rank: 94, name: 'Amitriptyline' },
  { key: 'folic_acid', rank: 95, name: 'Folic acid' },
  { key: 'rivaroxaban', rank: 96, name: 'Rivaroxaban' },
  { key: 'fenofibrate', rank: 97, name: 'Fenofibrate' },
  { key: 'triamcinolone', rank: 98, name: 'Triamcinolone' },
  { key: 'paroxetine', rank: 99, name: 'Paroxetine' },
  { key: 'ferrous_sulfate', rank: 100, name: 'Ferrous sulfate' },
];

// Medication allergies offered at check-in.
//
// Dr. Trinh's list (v0.0.15), in his order, behind the question "Do you have an
// allergy or serious reaction to any medication?" — NKDA / Yes / Unsure, with
// this checklist asked only on Yes.
//
// Seven keys carry over from the list before it because they mean the same
// thing; azithromycin, tylenol and lidocaine are relabelled to the wider class
// his list names. `nsaids` is deliberately NOT reused for "Ibuprofen / Naproxen
// / NSAIDs": its old label named Aspirin too, which is now its own item, and an
// old aspirin allergy must never read as if aspirin were not covered.
//
// Retired entries stay with intake:false and their OLD label, so an older
// record that logged one still displays it — never hide a logged allergy. Every
// anaesthetic the clinic carries (ANESTHETICS above) is among them, so an
// articaine allergy recorded last year is still on the chart at the chair.
export const ALLERGIES = [
  { key: 'penicillin', en: 'Penicillin', es: 'Penicilina' },
  { key: 'amoxicillin', en: 'Amoxicillin', es: 'Amoxicilina' },
  { key: 'ampicillin', en: 'Ampicillin', es: 'Ampicilina' },
  { key: 'cephalosporins', en: 'Cephalosporins', es: 'Cefalosporinas' },
  { key: 'sulfa', en: 'Sulfa antibiotics', es: 'Antibióticos de sulfa' },
  { key: 'azithromycin', en: 'Azithromycin / Erythromycin / Clarithromycin', es: 'Azitromicina / eritromicina / claritromicina' },
  { key: 'clindamycin', en: 'Clindamycin', es: 'Clindamicina' },
  { key: 'metronidazole', en: 'Metronidazole', es: 'Metronidazol' },
  { key: 'doxycycline', en: 'Doxycycline / tetracyclines', es: 'Doxiciclina / tetraciclinas' },
  { key: 'fluoroquinolones', en: 'Ciprofloxacin / Levofloxacin', es: 'Ciprofloxacino / levofloxacino' },
  { key: 'aspirin', en: 'Aspirin', es: 'Aspirina' },
  { key: 'ibuprofen_nsaids', en: 'Ibuprofen / Naproxen / NSAIDs', es: 'Ibuprofeno / naproxeno / AINEs' },
  { key: 'tylenol', en: 'Acetaminophen / Tylenol', es: 'Acetaminofén / Tylenol' },
  { key: 'codeine', en: 'Codeine', es: 'Codeína' },
  { key: 'hydrocodone', en: 'Hydrocodone', es: 'Hidrocodona' },
  { key: 'oxycodone', en: 'Oxycodone', es: 'Oxicodona' },
  { key: 'morphine', en: 'Morphine', es: 'Morfina' },
  { key: 'lidocaine', en: 'Lidocaine / local anesthetic', es: 'Lidocaína / anestésico local' },
  { key: 'general_anesthetic', en: 'General anesthetic', es: 'Anestesia general' },
  { key: 'anticonvulsant', en: 'Anticonvulsant', es: 'Anticonvulsivo' },
  { key: 'bp_medication', en: 'Blood pressure medication', es: 'Medicamento para la presión arterial' },
  { key: 'diuretic', en: 'Diuretic', es: 'Diurético' },
  { key: 'diabetes_medication', en: 'Insulin / diabetes medication', es: 'Insulina / medicamento para la diabetes' },
  { key: 'steroid', en: 'Steroid / corticosteroid', es: 'Esteroide / corticosteroide' },
  // Retired from check-in (v0.0.15, and Novocain in v1.4.8). Kept for display.
  { key: 'articaine', en: 'Articaine', es: 'Articaína', intake: false },
  { key: 'mepivacaine', en: 'Mepivacaine', es: 'Mepivacaína', intake: false },
  { key: 'bupivacaine', en: 'Bupivacaine', es: 'Bupivacaína', intake: false },
  { key: 'prilocaine', en: 'Prilocaine', es: 'Prilocaína', intake: false },
  { key: 'amoxicillin_clavulanate', en: 'Amoxicillin + clavulanate', es: 'Amoxicilina + clavulanato', intake: false },
  { key: 'erythromycin', en: 'Erythromycin', es: 'Eritromicina', intake: false },
  { key: 'nsaids', en: 'NSAIDs (Ibuprofen, Aspirin)', es: 'AINEs (Ibuprofeno, Aspirina)', intake: false },
  { key: 'novocain', en: 'Novocain', es: 'Novocaína', intake: false },
];

// The medication checklist on Dr. Trinh's form, in his order. `en` is the
// CANONICAL name, and it is what is stored as medications[].name whatever the
// patient's language: the blood-thinner rules in medFlags.js, db.js and pdf.js
// match on that stored name, and all three recognise Aspirin, Warfarin,
// Apixaban and Clopidogrel from it. `es` is only what a Spanish-speaking
// patient reads while ticking. Anything not listed goes under "Other", typed,
// with MEDICATIONS above as suggestions.
export const MED_CHECKLIST = [
  { key: 'atorvastatin', en: 'Atorvastatin (Lipitor)', es: 'Atorvastatina (Lipitor)' },
  { key: 'amlodipine', en: 'Amlodipine (Norvasc)', es: 'Amlodipino (Norvasc)' },
  { key: 'lisinopril', en: 'Lisinopril (Zestril/Prinivil)', es: 'Lisinopril (Zestril/Prinivil)' },
  { key: 'losartan', en: 'Losartan (Cozaar)', es: 'Losartán (Cozaar)' },
  { key: 'metformin', en: 'Metformin (Glucophage)', es: 'Metformina (Glucophage)' },
  { key: 'levothyroxine', en: 'Levothyroxine (Synthroid)', es: 'Levotiroxina (Synthroid)' },
  { key: 'omeprazole', en: 'Omeprazole (Prilosec)', es: 'Omeprazol (Prilosec)' },
  { key: 'gabapentin', en: 'Gabapentin (Neurontin)', es: 'Gabapentina (Neurontin)' },
  { key: 'hydrochlorothiazide', en: 'Hydrochlorothiazide (HCTZ)', es: 'Hidroclorotiazida (HCTZ)' },
  { key: 'metoprolol', en: 'Metoprolol', es: 'Metoprolol' },
  { key: 'rosuvastatin', en: 'Rosuvastatin (Crestor)', es: 'Rosuvastatina (Crestor)' },
  { key: 'aspirin', en: 'Aspirin', es: 'Aspirina' },
  { key: 'ibuprofen', en: 'Ibuprofen (Advil/Motrin)', es: 'Ibuprofeno (Advil/Motrin)' },
  { key: 'acetaminophen', en: 'Acetaminophen (Tylenol)', es: 'Acetaminofén (Tylenol)' },
  { key: 'albuterol', en: 'Albuterol (Ventolin/ProAir)', es: 'Albuterol / salbutamol (Ventolin/ProAir)' },
  { key: 'insulin', en: 'Insulin', es: 'Insulina' },
  { key: 'glipizide', en: 'Glipizide', es: 'Glipizida' },
  { key: 'furosemide', en: 'Furosemide (Lasix)', es: 'Furosemida (Lasix)' },
  { key: 'pantoprazole', en: 'Pantoprazole (Protonix)', es: 'Pantoprazol (Protonix)' },
  { key: 'sertraline', en: 'Sertraline (Zoloft)', es: 'Sertralina (Zoloft)' },
  { key: 'escitalopram', en: 'Escitalopram (Lexapro)', es: 'Escitalopram (Lexapro)' },
  { key: 'prednisone', en: 'Prednisone', es: 'Prednisona' },
  { key: 'warfarin', en: 'Warfarin (Coumadin)', es: 'Warfarina (Coumadin)' },
  { key: 'apixaban', en: 'Apixaban (Eliquis)', es: 'Apixabán (Eliquis)' },
  { key: 'clopidogrel', en: 'Clopidogrel (Plavix)', es: 'Clopidogrel (Plavix)' },
];

// "Major surgery in the past 6 months? If so, where" — the body sites on Dr.
// Trinh's form. At least one is required when the answer is Yes.
export const SURGERY_SITES = [
  { key: 'knee', en: 'Knee', es: 'Rodilla' },
  { key: 'elbow', en: 'Elbow', es: 'Codo' },
  { key: 'hip', en: 'Hip', es: 'Cadera' },
  { key: 'neck', en: 'Neck', es: 'Cuello' },
  { key: 'heart', en: 'Heart', es: 'Corazón' },
  { key: 'leg', en: 'Leg', es: 'Pierna' },
  { key: 'arm', en: 'Arm', es: 'Brazo' },
  { key: 'lung', en: 'Lung', es: 'Pulmón' },
  { key: 'kidney', en: 'Kidney', es: 'Riñón' },
  { key: 'liver', en: 'Liver', es: 'Hígado' },
];

// Step 3 (dental history): Dr. Trinh's eight Yes/No questions, in his order.
// `short` is the label clinicians read on the chart, the printed record and the
// spreadsheet. The prior-dentist dropdown and the "What do you need today?"
// scale stay on the step as they were — they drive routing and the surgery
// consent, and nothing in his list replaces them.
//
// `sores` reuses the old key: "Any sores or lumps in your mouth?" asked the same
// thing. Grinding does NOT — "at night" narrows it, and an old daytime clencher's
// Yes must not print as a night grinder — so it is `grinding_night`, and the old
// answer keeps its own row (DENTAL_LEGACY).
export const DENTAL_QUESTIONS = [
  { key: 'pain_cold', en: 'Any pain when drinking cold water?', es: '¿Siente dolor al tomar agua fría?', short: 'Pain with cold water' },
  { key: 'pain_hot', en: 'Any pain when drinking hot water?', es: '¿Siente dolor al tomar agua caliente?', short: 'Pain with hot water' },
  { key: 'pain_eating', en: 'Any pain when eating?', es: '¿Siente dolor al comer?', short: 'Pain when eating' },
  { key: 'toothache_night', en: 'Does the toothache wake you up at night?', es: '¿El dolor de muelas lo despierta por la noche?', short: 'Toothache wakes them at night' },
  { key: 'pain_touch', en: 'Any pain upon touching?', es: '¿Siente dolor al tocar la zona?', short: 'Pain on touch' },
  { key: 'grinding_night', en: 'Do you clench or grind your teeth at night?', es: '¿Aprieta o rechina los dientes por la noche?', short: 'Clenches / grinds at night' },
  { key: 'jaw_pain_waking', en: 'Do you wake up with jaw pain?', es: '¿Se despierta con dolor de mandíbula?', short: 'Wakes with jaw pain' },
  { key: 'sores', en: 'Do you notice any lump or sores in your mouth?', es: '¿Nota algún bulto o llaga en la boca?', short: 'Lump or sores in mouth' },
];

// The dental questions asked before v0.0.15. No longer asked, never written,
// but an older record keeps showing its answers under these labels.
export const DENTAL_LEGACY = [
  { key: 'gum_bleeding', label: 'Gums bleed' },
  { key: 'jaw_injury', label: 'Head/neck/jaw injury' },
  { key: 'grinding', label: 'Clenching / grinding' },
  { key: 'post_extraction_bleeding', label: 'Bleeding after extraction' },
  { key: 'ortho', label: 'Orthodontic history' },
];

// What the patient needs today — chosen on a 1–4 scale at check-in. Options 1 and
// 2 (extraction) trigger the oral-surgery consent. Shared so the check-in slider
// and the clinician screens all use the same labels.
// US states and territories, for the address field.
//
// Was a free-text box, which put "OR", "Oregon" and "ore" in the report as three
// different places — and the city/state breakdown is one of the figures a
// grant return is actually built from. Codes are stored, names are displayed.
export const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ['PR', 'Puerto Rico'], ['VI', 'U.S. Virgin Islands'], ['GU', 'Guam'], ['AS', 'American Samoa'],
  ['MP', 'Northern Mariana Islands'],
];

// Race and ethnicity, as ONE question.
//
// These are the seven minimum categories of OMB Statistical Policy Directive
// No. 15 as revised in March 2024 — the standard US federal and HHS grant
// reporting is scored against, which is the entire reason this field exists.
//
// The 2024 revision folded ethnicity INTO race: "Hispanic or Latino" is a
// category here, not a separate yes/no question as it was under the 1997
// standard. Collecting the combined answer is also the safe direction, because
// it can be crosswalked down to the old two-field layout later and a 1997-shaped
// answer cannot be crosswalked up.
//
// Select all that apply, and entirely optional — this is a free clinic, and a
// demographic question must never stand between a patient and care.
export const RACE = [
  { key: 'american_indian_alaska_native', en: 'American Indian or Alaska Native', es: 'Indígena de América o nativo de Alaska' },
  { key: 'asian', en: 'Asian', es: 'Asiático' },
  { key: 'black_african_american', en: 'Black or African American', es: 'Negro o afroamericano' },
  { key: 'hispanic_latino', en: 'Hispanic or Latino', es: 'Hispano o latino' },
  { key: 'middle_eastern_north_african', en: 'Middle Eastern or North African', es: 'De Medio Oriente o del norte de África' },
  { key: 'native_hawaiian_pacific_islander', en: 'Native Hawaiian or Pacific Islander', es: 'Nativo de Hawái o de las islas del Pacífico' },
  { key: 'white', en: 'White', es: 'Blanco' },
  { key: 'prefer_not', en: 'Prefer not to answer', es: 'Prefiero no responder' },
];

// Which station a patient goes to, derived from what they said they need.
// Mirrors VISIT_ROUTE in src/main/db.js, which is the authority — this copy
// exists only so the kiosk can SHOW the patient where they are being sent. The
// harness pins the two together.
//
// Returns null for an unknown or missing visit type rather than guessing: a
// returning patient starting a fresh visit has no visit_type yet, and silently
// defaulting them to the dentist would put cleanings in the wrong queue with
// nobody aware a guess had been made.
export function routeForVisitType(visitType) {
  const hit = VISIT_TYPES.find((v) => v.key === visitType);
  if (!hit) return null;
  return hit.key === 'cleaning' ? 'hygienist' : 'dentist';
}

// When the patient last saw a dentist. Was a free-text box, which produced
// answers like "a while ago" and "?" that no report could ever count — the whole
// reason the question is asked at a free clinic is to show unmet need.
//
// Two deliberate departures from the four buckets requested:
//   - the last bucket is "3 or more years", not "3 years", because otherwise a
//     patient who last went a decade ago has nowhere to go but an answer that is
//     simply false;
//   - "Never" exists, because at a free clinic it is one of the most common and
//     most reportable answers there is, and without it those patients would be
//     forced to claim a visit they never made.
export const PRIOR_DENTIST = [
  { key: 'within_6_months', en: 'Within the past 6 months', es: 'En los últimos 6 meses' },
  { key: 'about_1_year', en: 'About 1 year ago', es: 'Hace aproximadamente 1 año' },
  { key: 'about_2_years', en: 'About 2 years ago', es: 'Hace aproximadamente 2 años' },
  { key: 'over_3_years', en: '3 or more years ago', es: 'Hace 3 años o más' },
  { key: 'never', en: 'Never', es: 'Nunca' },
];

export const VISIT_TYPES = [
  { key: 'extraction_pain', en: 'Extraction — in pain', es: 'Extracción — con dolor', ru: 'Удаление — с болью', surgery: true },
  { key: 'extraction_no_pain', en: 'Extraction — no pain', es: 'Extracción — sin dolor', ru: 'Удаление — без боли', surgery: true },
  { key: 'filling', en: 'Filling', es: 'Empaste', ru: 'Пломба' },
  { key: 'cleaning', en: 'Dental cleaning', es: 'Limpieza dental', ru: 'Чистка зубов' },
];

const en = {
  common: {
    next: 'Next', back: 'Back', save: 'Save', cancel: 'Cancel', submit: 'Submit',
    yes: 'Yes', no: 'No', other: 'Other', none: 'None', add: 'Add', remove: 'Remove',
    clear: 'Clear', close: 'Close', search: 'Search', loading: 'Loading…',
    required: 'Required', optional: 'Optional', confirm: 'Confirm', continue: 'Continue',
    readAloud: 'Read aloud', stopReading: 'Stop', signHere: 'Sign here',
    clearSignature: 'Clear signature', print: 'Print', export: 'Export', saved: 'Saved.',
  },
  app: { name: 'Mission Minded', sub: 'Free Clinics', tagline: 'Free dental, medical and vision clinics' },
  login: {
    title: 'Sign in', subtitle: 'Clinic staff access',
    username: 'Username', password: 'Password', button: 'Sign in',
    error: 'Invalid username or password.',
    kiosk: 'Start patient check-in', kioskHint: 'Hand the device to a patient to begin intake',
  },
  roles: { admin: 'Administrator', doctor: 'Dentist', triage: 'Front Desk (legacy)', emt: 'EMT / Nurse', checkout: 'Check-Out', hygienist: 'Hygienist', registration: 'Registration' },
  nav: {
    dashboard: 'Dashboard', checkin: 'Check-In', triage: 'Triage', provider: 'Dental Triage',
    records: 'Records', reports: 'Reports', admin: 'Admin', logout: 'Sign out',
    emt: 'Vitals', checkout: 'Check-Out', hygienist: 'Cleanings',
  },
  dash: {
    title: 'Clinic Dashboard', event: 'Active event', noEvent: 'No active event',
    total: 'Patients today', waiting: 'Waiting for vitals', triaged: 'Waiting for provider',
    inTreatment: 'In treatment', completed: 'Completed', startCheckin: 'Start patient check-in',
    quick: 'Quick actions', recent: 'Recent patients', viewQueue: 'Open vitals station',
    backupPrompt: 'Remember to back up to USB before leaving the event.',
  },
  intake: {
    welcome: 'Welcome to Mission Minded', chooseLanguage: 'Please choose your language',
    start: 'Start', step: 'Step', of: 'of',
    s_language: 'Language', s_demographics: 'About You', s_medical: 'Medical History',
    s_dental: 'Dental History', s_consent: 'Consent', s_surgery: 'Surgery Consent', s_review: 'Sign & Submit',
    // demographics
    firstName: 'First name', lastName: 'Last name', dob: 'Date of birth', gender: 'Gender',
    genderM: 'Male', genderF: 'Female', genderO: 'Other',
    phone: 'Phone number', email: 'Email', address: 'Home address', mailing: 'Mailing address (if different)',
    city: 'City', state: 'State', cityOther: 'Please type your city', otherCity: 'Other',
    marital: 'Marital status', single: 'Single', married: 'Married', divorced: 'Divorced', widowed: 'Widowed',
    children: 'Children by age group', child0: '0–5 yrs', child6: '6–12 yrs', child13: '13–17 yrs', child18: '18+ yrs',
    emergencyName: 'Emergency contact name', emergencyPhone: 'Emergency contact phone',
    referral: 'How did you hear about us?', referralOther: 'Please specify',
    // medical
    vitalsTitle: 'Vitals', bp: 'Blood pressure', bpSys: 'Systolic', bpDia: 'Diastolic', hr: 'Heart rate (bpm)',
    underTreatment: 'Are you currently under a doctor’s care?', hospitalized: 'Hospitalized in the last 2 years?',
    // `hospitalized` and `pregnancy` are no longer asked (v0.0.15: major surgery
    // and the pregnancy row of the conditions table replace them); kept so the
    // wording an older record was answered under can still be named.
    tobacco: 'Do you smoke?', pregnancy: 'Pregnant, nursing, or taking contraceptives?',
    pregnancyNA: 'Not applicable', unsure: 'Unsure',
    majorSurgery: 'Major surgery within the past 6 months?', surgerySites: 'If so, where?',
    allergiesTitle: 'Medication allergies', allergiesHint: 'Check all that apply', allergyOther: 'Other allergy (specify)',
    allergyQuestion: 'Do you have an allergy or serious reaction to any medication?',
    nkda: 'No known drug allergies (NKDA)',
    conditionsTitle: 'Do you have any of these conditions?', conditionsHint: 'Answer Yes, No or Unsure for each', conditionOther: 'Other condition (optional)',
    medsTitle: 'Current medications', medName: 'Medication', medDose: 'Dose', medReason: 'Reason', addMed: 'Add medication',
    medsHint: 'Check every medication you take', medOther: 'Other medication (type the name)', noMeds: 'No medications',
    // dental
    reason: 'Reason for today’s visit', goals: 'Your long-term dental goals',
    priorDentist: 'When did you last see a dentist?',
    gumBleeding: 'Do your gums bleed?', sores: 'Any sores or lumps in your mouth?',
    jawInjury: 'Any head, neck, or jaw injury?', grinding: 'Do you clench or grind your teeth?',
    postExtraction: 'History of bleeding after a tooth was pulled?',
    ortho: 'Have you had braces or orthodontics?', cosmetic: 'Interested in cosmetic improvements?',
    // review
    reviewTitle: 'Review & sign', reviewHint: 'Please review your information, then sign below.',
    relationship: 'Relationship to patient (if signing for someone else)',
    signerName: 'Printed name of person signing',
    thanks: 'Thank you! Your check-in is complete.',
    thanksSub: 'Please return the device to the front desk.',
    done: 'Done', minorNotice: 'This patient is under 18 — a parent or guardian must sign.',
  },
  consent: {
    generalTitle: 'Patient Application and Consent for Health Care',
    generalIntro: 'Please read the following. You may tap “Read aloud” to hear it in your language.',
    // Complete general-consent wording (English authoritative). Rendered as a
    // numbered list at check-in and reused verbatim at the dentist's station.
    generalFull: [
      'PATIENT CONSENT FOR GENERAL PRIMARY CARE — I hereby authorize the Physicians, Nurses, Dentists and/or other health care providers of Mission Minded Worldwide (MMW), some of whom might be closely supervised advanced students, to examine and/or treat me and/or my dependent as named above. I understand that it is my responsibility to notify MMW of any changes in contact information, such as change of address or new telephone number when follow-up may be necessary.',
      'NOTICE OF DEEMED CONSENT FOR HIV, HEPATITIS B OR C TESTING — As a health care provider, we are making available to you the following notice: 1. If one of our health care professionals, workers or employees should be directly exposed to your blood or body fluids in a way that may transmit disease, your blood will be tested for infection with human immunodeficiency virus (the “AIDS” virus), Covid-19, as well as for Hepatitis B and C. A physician or other health care provider will tell you the result of the test. By checking “Yes” below, you are deemed to have consented to the release of the test results to the person exposed.',
      '2. If you should be directly exposed to blood or body fluids of one of our health care professionals, workers or employees in a way that may transmit the disease, that person’s blood will be tested for infection with human immunodeficiency virus (the “AIDS” virus), Covid-19, as well as for Hepatitis B and C. A physician or other health care provider will tell you and that person the results of the test.',
      'IMPORTANT NOTICE — MMW is a 501(c)3 charity with no paid volunteers and is NOT part of a government program. MMW volunteers may not be able to provide you with all the services you need, but if you would like to consult with our volunteer team and receive the type of treatment being offered today, please read the patient waiver below very carefully.',
      'PATIENT WAIVER — Dental Patients Note: While the volunteer hygienists, dentists and oral surgeons offer high quality procedures with good equipment, I understand that because of the number of people needing to be seen, I might not receive multiple extractions or multiple fillings. I understand that I might have certain medical conditions which would keep me from having the type of treatment I am requesting. I also understand that the dental care providers are volunteers, some from out-of-town, and are not available for follow-up care in the event of complications. I agree to seek any follow-up care I might need from my local dentist, health department, family physician or a hospital emergency room.',
      'I grant to MMW and their agents the right to use my picture, voice and other reproductions of my physical likeness in connection with advertising or publicizing MMW and their activities in all form of media in perpetuity.',
      'I, the undersigned patient, consent to the release of my patient records to other licensed health care professionals as necessary. I have read, or had read to me, and understand and agree to all of the above.',
    ],
    // Complete oral-surgery wording (English authoritative), rendered as paragraphs.
    // The tooth number(s) are captured in a field, not typed into the text.
    oralSurgeryFull: [
      'The surgery procedure that is to be performed has been explained to me and I understand the nature of my condition and of the proposed treatment. I also understand what health risks exist if the procedure is not done, such as pain, infection, decay, damage to other teeth and a more difficult surgery, as I get older.',
      'I agree to the administration of local anesthesia and other therapeutic measures as discussed that may be necessary for my comfort, safety and well-being.',
      'I realize that occasionally there are complications with this surgery and the medications. The more common complications include pain, swelling, bleeding, dry sockets, limited mouth opening, infection, bruising and discoloration of the skin, and temporary numbness and/or tingling of the lip, chin, teeth, or tongue.',
      'In some cases, even with the utmost care, there can be referred pain to the ear or neck; stiffness of the neck and facial muscles; changes in the bite and temporomandibular joint (TMJ); nausea; allergic reactions; bone fractures; injury to adjacent teeth; delayed healing; and permanent numbness of nerves in the facial area. Sinus complications, which may occur from the removal of upper teeth, include a root tip or tooth in the sinus or development of a lingering opening into the sinus from the mouth, which could require sinus treatments following surgery. I understand Mission Minded Worldwide (MMW) does not provide or pay for any of these additional treatments.',
      'Medications given during or after surgery may cause drowsiness and a lack of awareness and coordination, which could be increased by the use of alcohol or other drugs. I am aware that I should not operate any vehicle or hazardous device while taking such medications for at least 24 hours after taking them, or until recovered from their effects.',
      'I know that some of the above-mentioned complications can be avoided or reduced by carefully following dentist instructions. I have had an opportunity to ask questions about the procedure and aspects related to it and have had them answered to my satisfaction. This is my consent to surgery on the tooth number(s) recorded on this form.',
      'For prolonged swelling (growing bigger in 24–48 hrs) or no relief from pain: Call MMW at (951) 317-4968. Leave a message for Vinh Trinh. He will call you back and tell you how to get attention for your problem. If you have had to leave a message, be patient and wait until he calls back and gives you instructions. This post-op attention is only for treatment received and is not for continuing treatment on other teeth. If you experience difficulty breathing or swallowing, you should go to the Emergency Room for immediate treatment. MMW does not pay for any emergency room treatment, only for follow-up consultation with an approved local dentist to treat infection, pain, or swelling associated with treatment received at the free clinic.',
    ],
    // MMW hold-harmless / waiver (English authoritative — do not alter).
    // Key name kept as `oregon` so every existing caller keeps working.
    oregon: 'I certify that I have read this Consent, or that it has been read to me, and that I understand the above. The nature and purpose of such operation(s), procedure(s), treatment(s), and/or services and the reasons why the same is (are) considered necessary or advisable has been explained to me. I hereby hold Mission Minded Worldwide, its volunteer providers and the host facility harmless for the free care provided. Services are provided without compensation, the provider’s liability is limited, and the provider may not be held liable for any injury, death or other loss arising out of the provision of these services, unless the injury, death or other loss results from gross negligence.',
    clauses: [
      'I voluntarily consent to examination and treatment by the Mission Minded Worldwide volunteer team.',
      'I understand this is a free clinic staffed by volunteers and that treatment is provided as time and resources allow.',
      'I consent to the use of local anesthetics, sedatives, and other medications determined necessary for my care.',
      'I understand that dentistry is not an exact science and that no guarantees have been made about results.',
      'I understand the risks of treatment may include pain, swelling, infection, bleeding, and in rare cases injury to nerves or adjacent teeth.',
      'I agree to follow all post-treatment instructions given to me by the clinic team.',
    ],
    covidTitle: 'COVID-19 Risk Acknowledgment',
    covid: 'I understand that dental treatment may involve close contact and aerosol-generating procedures, and that no setting can be completely free of the risk of exposure to COVID-19 or other contagious illness. I accept this risk voluntarily.',
    surgeryTitle: 'Consent for Oral Surgery',
    surgeryIntro: 'This additional consent is required because an extraction may be performed today.',
    surgeryClauses: [
      'I consent to the removal of one or more teeth and the use of local anesthesia.',
      'I understand complications may include pain, swelling, bruising, infection, dry socket, bleeding, restricted jaw opening, injury to nearby teeth or fillings, and numbness of the lip, tongue, or chin that is usually temporary but can rarely be permanent.',
      'I understand that a tooth or root tip may break during removal and a small fragment may be left if removal would cause greater harm.',
      'I have informed the team of all medications and health conditions that may affect surgery or healing.',
    ],
    postOpTitle: 'Post-Operative Instructions',
    postOp: 'Bite firmly on gauze for 30–45 minutes. Do not rinse, spit, smoke, or use a straw for 24 hours. Eat soft foods and avoid the surgical area. Mild swelling and bleeding are normal. Take medications as directed.',
    // (951) 317-4968 is MMW's message line, not an emergency service (the
    // after-care sheet, src/main/aftercare.js 'general', says the same): a
    // true emergency goes to the ER. The other four languages follow this
    // wording and are awaiting MMW's review.
    emergency: 'For problems after your visit, call (951) 317-4968 and leave a message. If you have difficulty breathing or swallowing, go to the Emergency Room.',
    agree: 'I have read and understand the above, and I consent.',
  },
};

// Spanish — patient-facing intake + consents fully translated.
const es = {
  common: {
    next: 'Siguiente', back: 'Atrás', save: 'Guardar', cancel: 'Cancelar', submit: 'Enviar',
    yes: 'Sí', no: 'No', other: 'Otro', none: 'Ninguno', add: 'Agregar', remove: 'Quitar',
    clear: 'Borrar', close: 'Cerrar', search: 'Buscar', loading: 'Cargando…',
    required: 'Requerido', optional: 'Opcional', confirm: 'Confirmar', continue: 'Continuar',
    readAloud: 'Leer en voz alta', stopReading: 'Detener', signHere: 'Firme aquí',
    clearSignature: 'Borrar firma', print: 'Imprimir', export: 'Exportar', saved: 'Guardado.',
  },
  app: { name: 'Mission Minded', sub: 'Free Clinics', tagline: 'Clínicas gratuitas dentales, médicas y de visión' },
  login: {
    title: 'Iniciar sesión', subtitle: 'Acceso para el personal',
    username: 'Usuario', password: 'Contraseña', button: 'Entrar',
    error: 'Usuario o contraseña inválidos.',
    kiosk: 'Iniciar registro de paciente', kioskHint: 'Entregue el dispositivo al paciente para comenzar',
  },
  roles: { admin: 'Administrador', doctor: 'Dentista', triage: 'Recepción (anterior)', emt: 'Enfermero/a (EMT)', checkout: 'Salida', hygienist: 'Higienista', registration: 'Registro' },
  nav: {
    dashboard: 'Panel', checkin: 'Registro', triage: 'Triaje', provider: 'Triaje dental',
    records: 'Registros', reports: 'Reportes', admin: 'Admin', logout: 'Salir',
    emt: 'Signos vitales', checkout: 'Salida', hygienist: 'Limpiezas',
  },
  intake: {
    welcome: 'Bienvenido a Mission Minded', chooseLanguage: 'Por favor elija su idioma',
    start: 'Comenzar', step: 'Paso', of: 'de',
    s_language: 'Idioma', s_demographics: 'Sobre usted', s_medical: 'Historia médica',
    s_dental: 'Historia dental', s_consent: 'Consentimiento', s_surgery: 'Consentimiento de cirugía', s_review: 'Firmar y enviar',
    firstName: 'Nombre', lastName: 'Apellido', dob: 'Fecha de nacimiento', gender: 'Género',
    genderM: 'Masculino', genderF: 'Femenino', genderO: 'Otro',
    phone: 'Teléfono', email: 'Correo electrónico', address: 'Dirección', mailing: 'Dirección postal (si es diferente)',
    city: 'Ciudad', state: 'Estado', cityOther: 'Escriba su ciudad', otherCity: 'Otra',
    marital: 'Estado civil', single: 'Soltero/a', married: 'Casado/a', divorced: 'Divorciado/a', widowed: 'Viudo/a',
    children: 'Hijos por grupo de edad', child0: '0–5 años', child6: '6–12 años', child13: '13–17 años', child18: '18+ años',
    emergencyName: 'Nombre del contacto de emergencia', emergencyPhone: 'Teléfono de emergencia',
    referral: '¿Cómo se enteró de nosotros?', referralOther: 'Por favor especifique',
    vitalsTitle: 'Signos vitales', bp: 'Presión arterial', bpSys: 'Sistólica', bpDia: 'Diastólica', hr: 'Frecuencia cardíaca (lpm)',
    underTreatment: '¿Está bajo el cuidado de un médico actualmente?', hospitalized: '¿Hospitalizado en los últimos 2 años?',
    tobacco: '¿Fuma?', pregnancy: '¿Embarazada, amamantando o usando anticonceptivos?',
    pregnancyNA: 'No aplica', unsure: 'No estoy seguro/a',
    majorSurgery: '¿Cirugía mayor en los últimos 6 meses?', surgerySites: 'Si es así, ¿dónde?',
    allergiesTitle: 'Alergias a medicamentos', allergiesHint: 'Marque todas las que apliquen', allergyOther: 'Otra alergia (especifique)',
    allergyQuestion: '¿Tiene alergia o una reacción grave a algún medicamento?',
    nkda: 'Sin alergias conocidas a medicamentos (NKDA)',
    conditionsTitle: '¿Tiene alguna de estas condiciones?', conditionsHint: 'Responda Sí, No o No estoy seguro/a para cada una', conditionOther: 'Otra condición (opcional)',
    medsTitle: 'Medicamentos actuales', medName: 'Medicamento', medDose: 'Dosis', medReason: 'Motivo', addMed: 'Agregar medicamento',
    medsHint: 'Marque todos los medicamentos que toma', medOther: 'Otro medicamento (escriba el nombre)', noMeds: 'Sin medicamentos',
    reason: 'Motivo de la visita de hoy', goals: 'Sus metas dentales a largo plazo',
    priorDentist: '¿Cuándo visitó al dentista por última vez?',
    gumBleeding: '¿Le sangran las encías?', sores: '¿Llagas o bultos en la boca?',
    jawInjury: '¿Lesión en cabeza, cuello o mandíbula?', grinding: '¿Aprieta o rechina los dientes?',
    postExtraction: '¿Historial de sangrado después de una extracción?',
    ortho: '¿Ha usado frenos u ortodoncia?', cosmetic: '¿Interesado en mejoras cosméticas?',
    reviewTitle: 'Revisar y firmar', reviewHint: 'Por favor revise su información y firme abajo.',
    relationship: 'Relación con el paciente (si firma por otra persona)',
    signerName: 'Nombre en letra de molde de quien firma',
    thanks: '¡Gracias! Su registro está completo.',
    thanksSub: 'Por favor devuelva el dispositivo a la recepción.',
    done: 'Listo', minorNotice: 'Este paciente es menor de 18 — un padre o tutor debe firmar.',
  },
  consent: {
    generalTitle: 'Consentimiento General para Tratamiento Dental',
    generalIntro: 'Por favor lea lo siguiente. Puede tocar “Leer en voz alta” para escucharlo en su idioma.',
    oregon: 'Certifico que he leído este Consentimiento, o que me ha sido leído, y que entiendo lo anterior. Se me ha explicado la naturaleza y el propósito de tales operación(es), procedimiento(s), tratamiento(s) y/o servicios y las razones por las que se consideran necesarios o aconsejables. Por la presente eximo de responsabilidad a Mission Minded Worldwide, al Dentista Asociado y/o a dichos asistentes por la atención dental gratuita brindada. Los servicios se prestan sin compensación y la responsabilidad del proveedor es limitada y el proveedor no puede ser considerado responsable por ninguna lesión, muerte u otra pérdida que surja de la prestación de estos servicios, a menos que la lesión, muerte u otra pérdida resulte de negligencia grave. También soy consciente del riesgo de exposición al COVID durante un procedimiento dental y consiento participar en esta clínica bajo mi propio riesgo. (La versión en inglés es la versión legal autoritativa.)',
    clauses: [
      'Doy mi consentimiento voluntario para el examen y tratamiento dental por parte del equipo voluntario de Mission Minded Worldwide.',
      'Entiendo que esta es una clínica gratuita atendida por voluntarios y que el tratamiento se brinda según el tiempo y los recursos disponibles.',
      'Consiento el uso de anestésicos locales, sedantes y otros medicamentos que se consideren necesarios para mi atención.',
      'Entiendo que la odontología no es una ciencia exacta y que no se han hecho garantías sobre los resultados.',
      'Entiendo que los riesgos del tratamiento pueden incluir dolor, hinchazón, infección, sangrado y, en casos raros, lesión a nervios o dientes vecinos.',
      'Acepto seguir todas las instrucciones posteriores al tratamiento dadas por el equipo dental.',
      'Libero y eximo de responsabilidad a Mission Minded Worldwide, sus voluntarios y las instalaciones anfitrionas por la atención brindada de buena fe.',
    ],
    covidTitle: 'Reconocimiento del Riesgo de COVID-19',
    covid: 'Entiendo que el tratamiento dental puede implicar contacto cercano y procedimientos que generan aerosoles, y que ningún entorno puede estar completamente libre del riesgo de exposición al COVID-19 u otra enfermedad contagiosa. Acepto este riesgo voluntariamente.',
    surgeryTitle: 'Consentimiento de Cirugía Oral / Extracción',
    surgeryIntro: 'Este consentimiento adicional es necesario porque hoy podría realizarse una extracción.',
    surgeryClauses: [
      'Consiento la extracción de uno o más dientes y el uso de anestesia local.',
      'Entiendo que las complicaciones pueden incluir dolor, hinchazón, moretones, infección, alvéolo seco, sangrado, apertura limitada de la mandíbula, lesión a dientes u obturaciones cercanas, y entumecimiento del labio, lengua o mentón que suele ser temporal pero rara vez puede ser permanente.',
      'Entiendo que un diente o la punta de la raíz puede romperse durante la extracción y que un pequeño fragmento puede quedar si extraerlo causara mayor daño.',
      'He informado al equipo de todos los medicamentos y condiciones de salud que puedan afectar la cirugía o la recuperación.',
    ],
    postOpTitle: 'Instrucciones Postoperatorias',
    postOp: 'Muerda firmemente la gasa durante 30–45 minutos. No se enjuague, escupa, fume ni use pajilla por 24 horas. Coma alimentos blandos y evite el área quirúrgica. Una hinchazón y sangrado leves son normales. Tome los medicamentos según las indicaciones.',
    emergency: 'Si tiene problemas después de su visita, llame al (951) 317-4968 y deje un mensaje. Si tiene dificultad para respirar o tragar, vaya a la sala de emergencias.',
    agree: 'He leído y entiendo lo anterior, y doy mi consentimiento.',
  },
};

// Belizean Kriol — patient-facing pack (staff strings fall back to English).
// Community-reviewable; refine per deployment.
const bzj = {
  common: {
    next: 'Neks', back: 'Bak', save: 'Sayv', cancel: 'Kansl', submit: 'Send',
    yes: 'Yes', no: 'No', other: 'Ada', none: 'Non', add: 'Ad', remove: 'Tek weh',
    clear: 'Kliar', close: 'Kloaz', search: 'Serch', loading: 'Di lode…',
    required: 'Fi need', optional: 'Opshanal', confirm: 'Kanfaam', continue: 'Gwaan',
    readAloud: 'Reed loud', stopReading: 'Stap', signHere: 'Sain ya',
    clearSignature: 'Kliar sain', print: 'Print', export: 'Eksport', saved: 'Sayv.',
  },
  app: { name: 'Mission Minded', sub: 'Free Clinics', tagline: 'Free dental, medical an vizhan clinic' },
  login: { kiosk: 'Staat payshent chek-in', kioskHint: 'Gi di payshent di divais fi staat' },
  intake: {
    welcome: 'Welkom to Mission Minded', chooseLanguage: 'Pleez pick di langwij yu waahn',
    start: 'Staat', step: 'Step', of: 'a',
    s_language: 'Langwij', s_demographics: 'Bowt Yu', s_medical: 'Medikal Histri',
    s_dental: 'Dental Histri', s_consent: 'Kansent', s_surgery: 'Serjari Kansent', s_review: 'Sain & Send',
    firstName: 'Fos naym', lastName: 'Laas naym', dob: 'Baatdeh', gender: 'Jenda',
    genderM: 'Man', genderF: 'Uman', genderO: 'Ada',
    phone: 'Fone numba', email: 'Email', address: 'Hoam adres', mailing: 'Mailin adres (if difrent)',
    reason: 'Wai yu kom tudeh', goals: 'Yu lang-taim dental goal',
    allergiesTitle: 'Medisin alaji', allergiesHint: 'Pick aala weh aplai',
    // No conditionsHint: "pick all that apply" no longer describes the list,
    // which is answered row by row since v0.0.15, so English shows until translated.
    conditionsTitle: 'Yu hav eni a dehnya kandishan?',
    reviewTitle: 'Chek & sain', reviewHint: 'Pleez chek yu inafamayshan, den sain dong dehndeh.',
    signerName: 'Print naym a di persn weh di sain',
    thanks: 'Taanks! Yu chek-in don kompleet.', thanksSub: 'Pleez gi bak di divais to di frant desk.',
    done: 'Don', minorNotice: 'Dis payshent andah 18 — wahn payrent or gyaadyan haftu sain.',
  },
  consent: {
    generalTitle: 'Jeneral Kansent fi Dental Tritment',
    generalIntro: "Pleez reed evri paat. Yu ku tap 'Reed loud' fi yeer it eena yu langwij.",
    agree: 'Ah reed ahn andastan di tap, ahn ah gri.',
    surgeryTitle: 'Oral Serjari / Ekstrakshan Kansent',
    emergency: 'If yu ga prablem afta yu vizit, kaal (951) 317-4968 ahn lef wahn mesij. If yu ga chrobl fi breet or fi swalo, go da di Emerjensi Room.',
  },
};

// Nyanja / Chichewa — patient-facing pack (staff strings fall back to English).
const nya = {
  common: {
    next: 'Patsogolo', back: 'Bwerera', save: 'Sungani', cancel: 'Lekani', submit: 'Tumizani',
    yes: 'Inde', no: 'Ayi', other: 'Zina', none: 'Palibe', add: 'Onjezani', remove: 'Chotsani',
    clear: 'Chotsani', close: 'Tsekani', search: 'Sakani', loading: 'Ikukweza…',
    required: 'Zofunika', optional: 'Zosafunika', confirm: 'Tsimikizani', continue: 'Pitirizani',
    readAloud: 'Werengani mokweza', stopReading: 'Imani', signHere: 'Sayinani apa',
    clearSignature: 'Chotsani sayini', print: 'Sindikizani', export: 'Tumizani', saved: 'Zasungidwa.',
  },
  app: { name: 'Mission Minded', sub: 'Free Clinics', tagline: 'Zipatala zaulere za mano, zaumoyo ndi maso' },
  login: { kiosk: 'Yambani kulembetsa wodwala', kioskHint: 'Perekani chipangizo kwa wodwala kuti ayambe' },
  intake: {
    welcome: 'Takulandirani ku Mission Minded', chooseLanguage: 'Chonde sankhani chilankhulo chanu',
    start: 'Yambani', step: 'Sitepe', of: 'mwa',
    s_language: 'Chilankhulo', s_demographics: 'Za Inu', s_medical: 'Mbiri ya Thanzi',
    s_dental: 'Mbiri ya Mano', s_consent: 'Chilolezo', s_surgery: 'Chilolezo cha Opaleshoni', s_review: 'Sayinani & Tumizani',
    firstName: 'Dzina loyamba', lastName: 'Dzina lomaliza', dob: 'Tsiku lobadwa', gender: 'Amuna kapena akazi',
    genderM: 'Mwamuna', genderF: 'Mkazi', genderO: 'Zina',
    phone: 'Foni', email: 'Imelo', address: 'Adiresi ya kunyumba', mailing: 'Adiresi yotumizira (ngati ndi yosiyana)',
    reason: 'Chifukwa cha ulendo wa lero', goals: 'Zolinga zanu za mano zanthawi yayitali',
    allergiesTitle: 'Maantibayotiki / mankhwala oyambitsa allergy', allergiesHint: 'Sankhani zonse zogwirizana',
    // No conditionsHint: "choose all that apply" no longer describes the list,
    // which is answered row by row since v0.0.15, so English shows until translated.
    conditionsTitle: 'Kodi muli ndi imodzi mwa matenda awa?',
    reviewTitle: 'Wunikani & sayinani', reviewHint: 'Chonde wunikani zambiri zanu, kenako sayinani pansipa.',
    signerName: 'Dzina losindikiza la amene akusayina',
    thanks: 'Zikomo! Kulembetsa kwanu kwatha.', thanksSub: 'Chonde bwezerani chipangizo ku desiki yakutsogolo.',
    done: 'Zatha', minorNotice: 'Wodwalayu ali ndi zaka zosakwana 18 — kholo kapena msamali ayenera kusayina.',
  },
  consent: {
    generalTitle: 'Chilolezo Chonse cha Chithandizo cha Mano',
    generalIntro: "Chonde werengani gawo lililonse. Mukhoza kukanikiza 'Werengani mokweza' kuti mumve mu chilankhulo chanu.",
    agree: 'Ndawerenga ndipo ndamvetsa zomwe zili pamwamba, ndipo ndavomera.',
    surgeryTitle: 'Chilolezo cha Opaleshoni ya Mkamwa / Kuchotsa Dzino',
    emergency: 'Ngati muli ndi vuto mutachoka ku chipatala, imbani (951) 317-4968 ndipo musiye uthenga. Ngati mukuvutika kupuma kapena kumeza, pitani ku chipatala cha odwala mwadzidzidzi (Emergency Room).',
  },
};

// Russian — full patient-facing pack (staff screens fall back to English).
const ru = {
  common: {
    next: 'Далее', back: 'Назад', save: 'Сохранить', cancel: 'Отмена', submit: 'Отправить',
    yes: 'Да', no: 'Нет', other: 'Другое', none: 'Нет', add: 'Добавить', remove: 'Удалить',
    clear: 'Очистить', close: 'Закрыть', search: 'Поиск', loading: 'Загрузка…',
    required: 'Обязательно', optional: 'Необязательно', confirm: 'Подтвердить', continue: 'Продолжить',
    readAloud: 'Прочитать вслух', stopReading: 'Стоп', signHere: 'Подпишите здесь',
    clearSignature: 'Очистить подпись', print: 'Печать', export: 'Экспорт', saved: 'Сохранено.',
  },
  app: { name: 'Mission Minded', sub: 'Free Clinics', tagline: 'Бесплатные стоматологические, медицинские и офтальмологические клиники' },
  login: { kiosk: 'Начать регистрацию пациента', kioskHint: 'Передайте устройство пациенту, чтобы начать' },
  roles: { admin: 'Администратор', doctor: 'Стоматолог', triage: 'Регистратура (устар.)', emt: 'Медбрат/сестра', checkout: 'Выписка', hygienist: 'Гигиенист', registration: 'Регистрация' },
  intake: {
    welcome: 'Добро пожаловать в Mission Minded', chooseLanguage: 'Пожалуйста, выберите язык',
    start: 'Начать', step: 'Шаг', of: 'из',
    s_language: 'Язык', s_demographics: 'О вас', s_medical: 'История болезни',
    s_dental: 'Стоматологическая история', s_consent: 'Согласие', s_surgery: 'Согласие на операцию', s_review: 'Подпись и отправка',
    firstName: 'Имя', lastName: 'Фамилия', dob: 'Дата рождения', gender: 'Пол',
    genderM: 'Мужской', genderF: 'Женский', genderO: 'Другой',
    phone: 'Телефон', email: 'Эл. почта', address: 'Домашний адрес', mailing: 'Почтовый адрес (если отличается)',
    cityOther: 'Укажите ваш город', otherCity: 'Другой',
    marital: 'Семейное положение', single: 'Холост/не замужем', married: 'В браке', divorced: 'В разводе', widowed: 'Вдовец/вдова',
    children: 'Дети по возрастным группам', child0: '0–5 лет', child6: '6–12 лет', child13: '13–17 лет', child18: '18+ лет',
    emergencyName: 'Контактное лицо на случай ЧП', emergencyPhone: 'Телефон контактного лица',
    referral: 'Как вы узнали о нас?', referralOther: 'Уточните, пожалуйста',
    vitalsTitle: 'Показатели', bp: 'Артериальное давление', bpSys: 'Систолическое', bpDia: 'Диастолическое', hr: 'Пульс (уд/мин)',
    underTreatment: 'Находитесь ли вы сейчас под наблюдением врача?', hospitalized: 'Госпитализация за последние 2 года?',
    tobacco: 'Вы курите?', pregnancy: 'Беременность, кормление или приём контрацептивов?',
    pregnancyNA: 'Не применимо', unsure: 'Не уверен(а)', noMeds: 'Нет лекарств',
    allergiesTitle: 'Аллергия на лекарства', allergiesHint: 'Выберите все подходящие', allergyOther: 'Другая аллергия (укажите)',
    conditionsTitle: 'Есть ли у вас какие-либо из этих заболеваний?', conditionsHint: 'Ответьте «Да», «Нет» или «Не уверен(а)» на каждый пункт', conditionOther: 'Другое заболевание (необязательно)',
    medsTitle: 'Принимаемые лекарства', medName: 'Лекарство', medDose: 'Доза', medReason: 'Причина', addMed: 'Добавить лекарство',
    reason: 'Причина сегодняшнего визита', goals: 'Ваши долгосрочные стоматологические цели',
    priorDentist: 'Когда вы последний раз были у стоматолога?',
    gumBleeding: 'Кровоточат ли дёсны?', sores: 'Язвы или уплотнения во рту?',
    jawInjury: 'Травмы головы, шеи или челюсти?', grinding: 'Сжимаете или скрипите зубами?',
    postExtraction: 'Бывало ли кровотечение после удаления зуба?',
    ortho: 'Носили ли вы брекеты / ортодонтию?', cosmetic: 'Интересует косметическое улучшение?',
    reviewTitle: 'Проверка и подпись', reviewHint: 'Пожалуйста, проверьте свои данные и подпишите ниже.',
    relationship: 'Кем вы приходитесь пациенту (если подписываете за другого)',
    signerName: 'Печатными буквами имя подписавшего',
    thanks: 'Спасибо! Регистрация завершена.', thanksSub: 'Пожалуйста, верните устройство на стойку регистрации.',
    done: 'Готово', minorNotice: 'Пациенту меньше 18 лет — должен подписать родитель или опекун.',
  },
  consent: {
    generalTitle: 'Согласие на стоматологические процедуры, анестезию и освобождение от ответственности',
    generalIntro: 'Пожалуйста, прочитайте следующее. Можно нажать «Прочитать вслух», чтобы услышать на вашем языке.',
    oregon: 'Я подтверждаю, что прочитал(а) это Согласие или что оно было мне прочитано, и что я понимаю изложенное выше. Мне разъяснены характер и цель таких операций, процедур, лечения и/или услуг и причины, по которым они считаются необходимыми или целесообразными. Настоящим я освобождаю Mission Minded Worldwide, ассоциированного стоматолога и/или их помощников от ответственности за бесплатную стоматологическую помощь. Услуги предоставляются безвозмездно, ответственность поставщика ограничена, и поставщик не может нести ответственность за травму, смерть или иной ущерб, возникший в результате оказания этих услуг, кроме случаев, когда травма, смерть или иной ущерб являются следствием грубой небрежности. Я также осознаю риск заражения COVID во время стоматологической процедуры и соглашаюсь участвовать в этой клинике на свой страх и риск. (Английская версия является юридически обязательной.)',
    agree: 'Я прочитал(а) и понимаю изложенное выше и даю согласие.',
    surgeryTitle: 'Согласие на хирургию / удаление зуба',
    surgeryIntro: 'Это дополнительное согласие необходимо, так как сегодня может быть проведено удаление.',
    emergency: 'При проблемах после визита звоните (951) 317-4968 и оставьте сообщение. Если вам трудно дышать или глотать, обратитесь в отделение неотложной помощи.',
  },
};

export const CATALOG = { en, es, ru, bzj, nya };
