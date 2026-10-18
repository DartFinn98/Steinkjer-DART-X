# Steinkjer DART-X

Norsk poengtavle for 501 med stålpiler. Lagre og velg spillere fra spillerlisten, velg best av 3, 5 eller 7 legger, og registrer kastene enkeltvis eller som en totalsum. Trykk på poengsummen for å rette den; bruk Angre for å rulle tilbake en retting eller et kast. Steinkjer DART-X håndterer bust og dobbel ut, viser legg- og kampresultater og kan installeres som en nettapp.

Spillernavn kan legges til, velges og slettes fra spillerlisten. Når Supabase er konfigurert, deler innloggede brukere spillerlisten og kampresultatene. På en enhet der appen allerede er åpnet på nett, kan den også brukes offline. Lokale endringer lagres på enheten og synkroniseres når forbindelsen kommer tilbake; e-postrapporter legges også i kø. Uten Supabase lagres data bare lokalt i nettleseren. Sletting av en spillerprofil fjerner ikke tidligere kampresultater.

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

Appen bruker Supabase Auth for e-post/passord-kontoer. Når Supabase er konfigurert, må brukeren være innlogget for å bruke appen. Alle innloggede kontoer i Supabase-prosjektet deler klubbens spillerliste og kampresultater.

1. Opprett et Supabase-prosjekt.
2. Kjør `supabase/schema.sql` i prosjektets SQL Editor. Tabellenes Row Level Security begrenser tilgang til innloggede brukere.
3. Kopier `.env.example` til `.env.local`, og fyll inn prosjektets Project URL og anon/public key som `VITE_SUPABASE_URL` og `VITE_SUPABASE_ANON_KEY`.
4. I Supabase Auth-innstillingene setter du Site URL og tillatte redirect-adresser for lokal utvikling og publisert domene. E-postbekreftelse kan være aktivert for nye kontoer. Tilbakestilling av passord bruker samme adresse; legg både lokal adresse og publisert domene i listen over tillatte redirects.
5. Legg de samme miljøvariablene inn i webhotellet før du bygger og publiserer appen.
6. Bekreft et avsenderdomene i Resend.
7. Sett `RESEND_API_KEY` og `RESEND_FROM_EMAIL` som Edge Function secrets i Supabase Dashboard. Ikke legg Resend-nøkkelen i `.env.local` eller frontend-koden.
8. Publiser e-postfunksjonen med `supabase functions deploy send-match-report`. Funksjonen krever gyldig Supabase-innlogging (`verify_jwt = true`).

Bruk **Glemt passord?** på innloggingssiden for å få tilsendt en tilbakestillingslenke. Ikke legg en `service_role`-nøkkel i appen. Alle registrerte brukere får tilgang til de delte klubbdataene; del derfor registreringsadressen med personer som skal ha tilgang.

Etter en vunnet kamp sendes rapporten til e-postadressen til brukeren som er logget inn. Rapporten inneholder kampresultat, leggseier, 3-pilssnitt, antall 100+-runder og 180-ere, høyeste runde og registrerte turer for hver spiller. I totalsummodus velges antall piler brukt manuelt. E-post kan ikke sendes før Supabase- og Resend-oppsettet over er fullført.

## Regler

Alle spillere starter på 501. Hver tur består av tre piler, med opptil 60 poeng per pil. Ved dobbel ut må den siste pilen treffe en dobbel. Du får bust hvis du går under 0, står igjen med 1 eller treffer 0 uten å avslutte med en dobbel. Da beholder du poengsummen fra før turen, og turen går videre.

Når du registrerer en totalsum, må du også merke av hvis den siste pilen traff en dobbel for å fullføre en utgang.

Kampen starter med et bullkast. Spilleren som kommer nærmest bull, begynner. I kamper med flere legger starter neste legg med den neste spilleren i rekkefølgen. Når en spiller står igjen med nøyaktig 42 poeng, kan dere avgjøre leggen med et nytt bullkast.
