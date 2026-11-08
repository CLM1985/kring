// Kring – koppeling met Supabase.
// Leeg laten = demomodus (gegevens enkel in deze browser).
// Invullen met de Project URL en de publishable key (Settings > API).
// De publishable key mag publiek staan: de beveiliging zit in RLS.
// NOOIT de service_role/secret key of de database-URL hier zetten.
window.KRING_CONFIG = {
  supabaseUrl: "",
  supabaseKey: ""
};
