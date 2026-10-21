# Steinkjer DART-X

Norsk poengtavle for 501, Cricket og 121-utgang med stålpiler. Spill individuelt med én til fire spillere, eller dobbel i 2 mot 2. Lagkamerater deler poengsum og Cricket-felt og kaster annenhver tur. Velg bane 1–5; banevalget huskes på mini-PC-en og lagres med kampresultatet. Avsluttede kamper finnes i et søkbart kamparkiv med spillerstatistikk og registrerte turer. Velg best av 3, 5, 7 eller 9 legger, og registrer kastene enkeltvis eller som en totalsum. Trykk på poengsummen for å rette den; bruk Angre for å rulle tilbake en retting eller et kast. Steinkjer DART-X håndterer bust og dobbel ut, viser legg- og kampresultater og kan installeres som en nettapp.

Spillernavn kan legges til, velges og slettes fra spillerlisten. Bekreftede kontoer vises automatisk i **Spillere** og i forslagene når du velger spillere til en kamp. Ved kontooppretting velger brukeren et visningsnavn på 1–24 tegn; visningsnavnet deles i klubbens spillerliste, aldri e-postadressen. Knappen **Påmelding** åpner påmelding til kommende mandags- og torsdagskvelder. Med Supabase lagres påmeldingene delt, og hver innloggede bruker kan endre eller slette sin egen påmelding. Innloggede brukere kan også knytte kontoen til et spillernavn, laste opp et privat profilbilde og se samlet kampstatistikk under **Min statistikk**. Profilbilder kan være JPG, PNG eller WebP på opptil 2 MB. Gjestespillere kan fortsette uten konto ved å velge et visningsnavn. Gjestens spillerliste og kampresultater lagres bare midlertidig i gjeldende nettleserfane; de slettes når gjesteøkten avsluttes eller fanen lukkes, og deles ikke med klubben. Uten Supabase lagres påmeldinger lokalt i nettleseren, og profilstatistikk og profilbilder krever en innlogget Supabase-konto. Påmelding og profilkobling krever nett når Supabase er konfigurert. På en enhet der appen allerede er åpnet på nett, kan den også brukes offline. Lokale kamp- og spillerendringer lagres på enheten og synkroniseres når forbindelsen kommer tilbake. Hvis synkronisering feiler, viser appen hvilken type endring som står igjen og Supabase-feilen som må løses. E-postrapporter prøves sendt på nytt når forbindelsen og e-posttjenesten er tilgjengelige, men regnes ikke som ventende kampdata. Sletting av en spillerprofil fjerner ikke tidligere kampresultater.

## Kom i gang

Krever Node.js og npm. Fra prosjektmappen:

```sh
npm install
npm run dev -- --host 0.0.0.0
```

Åpne adressen Vite viser. For mobil må telefon og datamaskin være på samme Wi-Fi; åpne datamaskinens lokale IPv4-adresse med porten Vite viser.

## Produksjonsbygg

```sh
npm run build
npm run preview
```

## Gratis publisering med Netlify

Prosjektet inneholder `netlify.toml`, som bygger appen og publiserer `dist/` automatisk.

1. Legg prosjektet i et GitHub-repositorium og koble repositoriet til en Netlify-konto med gratisplan.
2. Netlify bruker byggekommandoen `npm run build` og publiseringsmappen `dist` fra `netlify.toml`.
3. Legg `VITE_SUPABASE_URL` og `VITE_SUPABASE_ANON_KEY` inn under nettstedets miljøvariabler i Netlify. Bruk Supabase Project URL og anon/public key; ikke bruk `service_role`-nøkkelen.
4. Publiser nettstedet, og legg Netlify-adressen til i Supabase Auth sine Site URL- og Redirect URL-innstillinger.
5. Følg Supabase- og Resend-oppsettet nedenfor for delt spillerliste, kampdata, kontoer og e-postrapporter.

Produksjonsappen krever Supabase-variablene. Uten dem viser den en konfigurasjonsmelding i stedet for å bruke lokal lagring som om dataene var delt.

## Kontoer og felles lagring

Appen bruker Supabase Auth for e-post/passord-kontoer. Ved registrering oppgir brukeren et visningsnavn, og bekreftede kontoer vises automatisk i spillerlisten. Visningsnavnene er synlige for besøkende som åpner **Spillere**; e-postadressene deles ikke. Når Supabase er konfigurert, kan brukeren logge inn eller fortsette som gjest. Kontoer gir tilgang til de delte klubbdataene, mens gjester bare kan bruke poengtavlen med et visningsnavn. Gjestens data holdes midlertidig i fanens session-lagring og blir ikke sendt til Supabase.

1. Opprett et Supabase-prosjekt.
2. Kjør `supabase/schema.sql` i prosjektets SQL Editor. Kjør filen på nytt ved oppgradering for å oppdatere tabeller, policyer og funksjoner. Spillerkatalogen deler bare visningsnavn, ikke e-postadresser.
3. Kopier `.env.example` til `.env.local`, og fyll inn prosjektets Project URL og anon/public key som `VITE_SUPABASE_URL` og `VITE_SUPABASE_ANON_KEY`.
4. I Supabase Auth-innstillingene setter du Site URL og tillatte redirect-adresser for lokal utvikling og publisert domene. E-postbekreftelse kan være aktivert for nye kontoer. Tilbakestilling av passord bruker samme adresse; legg både lokal adresse og publisert domene i listen over tillatte redirects.
5. Legg de samme miljøvariablene inn i webhotellet før du bygger og publiserer appen.
6. Bekreft et avsenderdomene i Resend.
7. Sett `RESEND_API_KEY` og `RESEND_FROM_EMAIL` som Edge Function secrets i Supabase Dashboard. Ikke legg Resend-nøkkelen i `.env.local` eller frontend-koden.
8. Publiser e-postfunksjonen med `supabase functions deploy send-match-report`. Funksjonen krever gyldig Supabase-innlogging (`verify_jwt = true`).

Kampresultatrapporten sendes separat til hver bekreftede konto som har koblet spillerprofilen sin til en spiller i kampen. Gjester og spillere uten en koblet, bekreftet e-postkonto mottar ikke e-post.

Bruk **Glemt passord?** på innloggingssiden for å få tilsendt en tilbakestillingslenke. Ikke legg en `service_role`-nøkkel i appen. Alle registrerte brukere får tilgang til de delte klubbdataene; del derfor registreringsadressen med personer som skal ha tilgang.

Etter en vunnet kamp sendes rapporten separat til de bekreftede e-postadressene til kontoene som har koblet spillerprofilene sine til spillerne i kampen. Kontoer uten koblet spillerprofil og gjester mottar ikke rapporten. Rapporten inneholder kampresultat, leggseier, 3-pilssnitt, antall 100+-runder og 180-ere, høyeste runde og registrerte turer for hver spiller. I totalsummodus velges antall piler brukt manuelt. E-post kan ikke sendes før Supabase- og Resend-oppsettet over er fullført.

### Administrator for klubbpåmelding

Kjør `supabase/schema.sql` på nytt etter oppgradering for å opprette administratorroller, sikre policyer og rollefunksjoner. Den første administratoren må legges til manuelt i Supabase SQL Editor etter at kontoen er opprettet. Bytt ut e-postadressen med den som brukes til innlogging:

```sql
insert into public.club_admins (user_id)
select id
from auth.users
where lower(email) = lower('din-epost@example.no')
on conflict (user_id) do nothing;
```

Logg deretter inn i appen på nytt. Administratorer får menyvalget **Administrasjon**, der de kan se kommende deltakerlister samlet, legge til spillere uten konto på en valgt klubbkveld, rette navn eller dato, slette feilpåmeldinger og laste ned en CSV-fil for én eller alle klubbkvelder. Manuelle gjestepåmeldinger merkes i listen og er beskyttet mot duplikatnavn samme kveld. De kan også laste opp, laste ned og slette private klubb-dokumenter på opptil 25 MB per fil. Dokumentene er bare tilgjengelige for klubbadministratorer. Kjør `supabase/schema.sql` på nytt for å opprette den private Storage-bøtten, tillate gjestepåmeldinger uten konto og oppdatere tilhørende databasefunksjoner og administratorpolicyer. Administratorer kan også gi eller fjerne rollen ved å skrive inn e-postadressen til en eksisterende, e-postbekreftet konto. Kontoen må være opprettet før rollen gis. Rollen kan ikke gis direkte fra appen av en vanlig bruker, og administratorer kan ikke fjerne sin egen rolle.

Administratorrollen håndheves av Supabase Row Level Security og databasefunksjoner; det er ikke tilstrekkelig å bare vise eller skjule menyknappen. Ikke del Supabase `service_role`-nøkkelen.

### Turnering på klubbkvelden

Turneringsoppsettet ligger under **Administrasjon**, under deltakerlistene, og er bare tilgjengelig for klubbadministratorer. Velg klubbkveld, sett eventuelle seedingsnummer og trekk puljene fra påmeldingene. Puljene fordeles så jevnt som mulig, seedede spillere spres først, og hver pulje har maksimalt åtte spillere. Alle møter alle i puljen. Kampdagoversikten viser pågående kamper og leggstilling, baner som er i bruk eller ledige, og de neste kampene i køen. Den viser også dommeren: i puljespill foreslås en spiller som ikke deltar i kampen, men som skal spille senere i puljen; i cupen tildeles taperen fra forrige runde som dommer for neste runde. Pågående eldre kamper uten banenummer må tildeles en bane før appen kan bekrefte ledige baner eller starte nye kamper. Start hver kamp med **Spill kamp på poengtavla**; bane, foreslått puljedommer og kampstilling lagres automatisk i Supabase, og kampen kan fortsettes fra en annen innlogget enhet etter at nettleseren er lukket. Når turneringsresultatet er lagret, starter **Klar til neste kamp** den neste ledige kampen direkte. Når kampen er ferdig, registreres leggresultatet og vinneren automatisk i turneringen. Tabellene rangeres etter seire, leggdifferanse, seeding og navn. Administrator velger fortsatt manuelt hvem som går videre fra puljene. I cupen opprettes neste runde automatisk når alle kampene i gjeldende runde er ferdige. Administratorer kan bruke **Skriv ut skjemaer** for å lage A4-ark for hver pulje med spillerliste, tabell og kampresultater; små puljer får større resultatfelt uten tomme spillerruter. Når cupen er trukket, blir cuprundene også med på egne utskriftsark med kampnumre som peker til riktig vinner i neste runde. Eldre turneringer kan åpnes fra **Arkiv for turneringsark** og skrives ut på nytt. Arkivet viser tydelig om puljekamper gjenstår eller en cuprunde er i gang. Administratorer kan slette én turnering eller bekrefte sletting av alle turneringer fra arkivet; sletting kan ikke angres. Arkivet lagrer turneringsdataene, og nettleserens utskriftsvalg kan brukes til å lagre PDF-kopier.

Cupen trekker de videregående spillerne i et seedet cupoppsett og gir walkover der det trengs. Kampformatet følger klubbens skjema: puljespill best av 3 legg, de første cuprundene best av 5, semifinaler best av 7 og finale best av 9. Med to spillere som går videre blir den ene cupkampen finalen; med fire blir første cuprunde semifinalene.

Turneringer og resultater lagres i Supabase-tabellen `club_tournaments`. Kjør `supabase/schema.sql` på nytt etter oppgradering for å opprette eller oppdatere tabellen, databasefunksjonene og administratorpolicyene. Status for spillernes innsjekking oppdateres atomisk uten å overskrive kampframdrift som lagres samtidig. Klubbadministratorer kan starte opptil fem ulike turneringskamper samtidig, én per bane; kampframdrift og resultater lagres separat per kamp slik at banene ikke overskriver hverandre. Kampoversikten oppdateres automatisk mens turneringssiden er åpen.

## Regler

501 starter på 501 poeng, mens 121-utgang starter på 121. Begge bruker dobbel ut: siste pil må treffe en dobbel. Bust skjer hvis du går under 0, står igjen med 1 eller treffer 0 uten dobbel; poengsummen fra før turen beholdes.

I Cricket teller feltene 15–20 og bull. Tre treff lukker et felt; dobbel teller to treff, trippel tre, og indre bull to. Treff på et lukket felt gir poeng så lenge minst én motspiller ikke har lukket feltet. Alle feltene må være lukket, og du må ha minst like mange poeng som hver motspiller, for å vinne.

Når du registrerer en totalsum, må du også merke av hvis den siste pilen traff en dobbel for å fullføre en utgang.

Kampen starter med et bullkast. Spilleren som kommer nærmest bull, begynner. I kamper med flere legger starter neste legg med den neste spilleren i rekkefølgen. Hvis en 501-legg ikke er avgjort etter at hver spiller har kastet 42 piler, avgjøres leggen med bull-off: kast mot bull, og trykk på navnet til spilleren som kom nærmest.
