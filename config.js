// Kring – koppeling met Supabase (project Gezinsbudget, schema gezin).
// De publishable key mag publiek staan: de beveiliging zit in RLS.
// NOOIT de service_role/secret key of de database-URL hier zetten.
window.KRING_CONFIG = {
  supabaseUrl: "https://yjeldhekcpylxjemcrff.supabase.co",
  supabaseKey: "sb_publishable_goNAG0Cn2MC_CA1ACJ9eTQ_Pfy_Si36"
};
