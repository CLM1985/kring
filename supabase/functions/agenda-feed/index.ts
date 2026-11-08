// Kring – agenda als ICS-feed, om in Google Agenda (of op de iPhone) te abonneren.
// Link: https://<project>.supabase.co/functions/v1/agenda-feed?token=<token uit gezin.agenda_feed>
// Geen login (Google kan niet aanmelden): de geheime token is de toegang. Deploy met --no-verify-jwt.
// Leest met de service-role-sleutel enkel het gezin van die token.
import { createClient } from "jsr:@supabase/supabase-js@2";

const esc = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const d8 = (d: string) => d.replace(/-/g, "");
const vouw = (r: string) => r.length <= 74 ? r : r.match(/.{1,74}/g)!.join("\r\n ");
const plusDag = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const FREQ: Record<string, string> = { dag: "DAILY", week: "WEEKLY", maand: "MONTHLY", jaar: "YEARLY" };

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!/^[0-9a-f]{48}$/.test(token)) return new Response("Onbekende link", { status: 404 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { db: { schema: "gezin" } });
  const { data: f } = await sb.from("agenda_feed").select("huishouden_id").eq("token", token).maybeSingle();
  if (!f) return new Response("Onbekende link", { status: 404 });
  const h = f.huishouden_id;
  const [{ data: af }, { data: kal }, { data: tk }, { data: vj }] = await Promise.all([
    sb.from("afspraken").select("*").eq("huishouden_id", h).is("ics_uid", null),
    sb.from("kalenders").select("id,naam").eq("huishouden_id", h),
    sb.from("taken").select("*").eq("huishouden_id", h),
    sb.from("verjaardagen").select("*").eq("huishouden_id", h)]);
  const kn = Object.fromEntries((kal || []).map((k) => [k.id, k.naam]));
  const r: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kring//Gezinsagenda//NL", "X-WR-CALNAME:Kring", "X-WR-TIMEZONE:Europe/Brussels", "CALSCALE:GREGORIAN"];
  const rrule = (x: any) => x.herh_freq ? `RRULE:FREQ=${FREQ[x.herh_freq]};INTERVAL=${x.herh_interval || 1}${x.herh_freq === "week" && x.herh_dagen?.length ? ";BYDAY=" + x.herh_dagen.map((d: number) => BYDAY[d - 1]).join(",") : ""}${x.herh_tot ? ";UNTIL=" + d8(x.herh_tot) + "T235959Z" : ""}` : null;
  const event = (uid: string, titel: string, datum: string, tot: string | null, start: string | null, eind: string | null, extra: string[]) => {
    r.push("BEGIN:VEVENT", `UID:${uid}@kring`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`, vouw(`SUMMARY:${esc(titel)}`));
    if (start) { r.push(`DTSTART;TZID=Europe/Brussels:${d8(datum)}T${start.replace(":", "").slice(0, 4)}00`); r.push(`DTEND;TZID=Europe/Brussels:${d8(tot || datum)}T${(eind || start).replace(":", "").slice(0, 4)}00`); }
    else { r.push(`DTSTART;VALUE=DATE:${d8(datum)}`, `DTEND;VALUE=DATE:${d8(plusDag(tot || datum, 1))}`); }
    extra.filter(Boolean).forEach((e) => r.push(vouw(e))); r.push("END:VEVENT");
  };
  for (const a of af || []) event(a.id, a.titel, a.datum, a.datum_tot, a.hele_dag ? null : a.start_tijd, a.eind_tijd, [
    rrule(a) || "", a.plaats ? `LOCATION:${esc(a.plaats)}` : "", `DESCRIPTION:${esc([kn[a.kalender_id], a.notitie].filter(Boolean).join("\n"))}`,
    ...(a.uitzonderingen || []).map((d: string) => a.hele_dag || !a.start_tijd ? `EXDATE;VALUE=DATE:${d8(d)}` : `EXDATE;TZID=Europe/Brussels:${d8(d)}T${a.start_tijd.replace(":", "").slice(0, 4)}00`)]);
  for (const t of tk || []) event("taak-" + t.id, "☐ " + t.titel, t.deadline, null, t.tijd, null, [rrule(t) || ""]);
  for (const v of vj || []) event("verj-" + v.id, "Verjaardag " + v.naam, v.datum, null, null, null, ["RRULE:FREQ=YEARLY"]);
  r.push("END:VCALENDAR");
  return new Response(r.join("\r\n") + "\r\n", { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "max-age=900" } });
});
