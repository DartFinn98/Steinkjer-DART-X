# Steinkjer DART-X

Norsk poengtavle for 501, Cricket og 121-utgang med stålpiler. Spill individuelt med én til fire spillere, eller dobbel i 2 mot 2. Lagkamerater deler poengsum og Cricket-felt og kaster annenhver tur. Velg bane 1–5; banevalget huskes på mini-PC-en og lagres med kampresultatet. Avsluttede kamper finnes i et søkbart kamparkiv med spillerstatistikk og registrerte turer. Velg best av 3, 5, 7 eller 9 legger, og registrer kastene enkeltvis eller som en totalsum. Trykk på poengsummen for å rette den; bruk Angre for å rulle tilbake en retting eller et kast. Steinkjer DART-X håndterer bust og dobbel ut, viser legg- og kampresultater og kan installeres som en nettapp.

Spillernavn kan legges til, velges og slettes fra spillerlisten. Knappen **Påmelding** åpner påmelding til kommende mandags- og torsdagskvelder. Med Supabase lagres påmeldingene delt, og hver innloggede bruker kan endre eller slette sin egen påmelding. Uten Supabase lagres de lokalt i nettleseren. Påmelding krever nett når Supabase er konfigurert. På en enhet der appen allerede er åpnet på nett, kan den også brukes offline. Lokale kampendringer lagres på enheten og synkroniseres når forbindelsen kommer tilbake; e-postrapporter legges også i kø. Sletting av en spillerprofil fjerner ikke tidligere kampresultater.

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

501 starter på 501 poeng, mens 121-utgang starter på 121. Begge bruker dobbel ut: siste pil må treffe en dobbel. Bust skjer hvis du går under 0, står igjen med 1 eller treffer 0 uten dobbel; poengsummen fra før turen beholdes.

I Cricket teller feltene 15–20 og bull. Tre treff lukker et felt; dobbel teller to treff, trippel tre, og indre bull to. Treff på et lukket felt gir poeng så lenge minst én motspiller ikke har lukket feltet. Alle feltene må være lukket, og du må ha minst like mange poeng som hver motspiller, for å vinne.

Når du registrerer en totalsum, må du også merke av hvis den siste pilen traff en dobbel for å fullføre en utgang.

Kampen starter med et bullkast. Spilleren som kommer nærmest bull, begynner. I kamper med flere legger starter neste legg med den neste spilleren i rekkefølgen. Når en spiller står igjen med nøyaktig 42 poeng, kan dere avgjøre leggen med et nytt bullkast.
