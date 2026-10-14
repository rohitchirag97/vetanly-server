To install dependencies:
```sh
bun install
```

To run:
```sh
bun run dev
```

This starts both the API and its background workers for local development.
Copy `.env.example` to `.env` and fill it in, then start Postgres and Redis with
`docker compose up -d`. Compose and the app read the same `POSTGRES_*` and
`REDIS_*` values from `.env`, so they always agree.

The OTP worker currently prints a development OTP to the console. Configure an
SMS provider before using OTP delivery in production; the worker fails those
jobs until a provider is implemented.

In production, run the whole application, including the API and background
workers, with:
```sh
bun run start
```

Open http://localhost:8000

## Platform admin console

The owner console is available at `/platform` in the client app. Apply the
database migration with `bun run db:migrate` from this directory before using
the new platform schema. Existing organization creation dates remain unknown;
the console only reports signup history from dates recorded after this schema
change.

To grant access to the app owner's existing account:

1. Sign in once with that account's phone number and OTP so its user record
   exists.
2. Run `bun run platform:promote +<country-code-and-phone>` from this
   directory, for example `bun run platform:promote +919876543210`.
3. Sign in with the promoted account and open `/platform`. The console asks for
   a fresh OTP and keeps platform access verified for 30 minutes.

The promotion command changes only the platform-admin flag for the matching
phone number. Keep its use restricted to trusted server operators.

### Platform billing

The verified owner console includes a plan catalog, manual plan assignments,
customer billing profiles, sequential INR invoices with configurable GST,
PDF downloads, offline payment recording, voiding, and queued WhatsApp delivery.
Apply the new `20261011131500_platform_billing` migration with `bun run db:migrate` before opening Plans or Invoices. Invoice creation requires a saved
billing profile on the organization detail screen.

Set the seller identity using `PLATFORM_BILLING_NAME`,
`PLATFORM_BILLING_ADDRESS`, `PLATFORM_BILLING_GSTIN`, and
`PLATFORM_BILLING_EMAIL`. Leave the seller GSTIN empty until the correct legal
entity details are available.

WhatsApp delivery uses AiSensy API campaigns and requires:

- `AISENSY_API_KEY` and `AISENSY_INVOICE_CAMPAIGN_NAME` on the server.
- Cloudflare `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and
  `R2_BUCKET` values so the worker can upload the PDF and create a temporary
  download link.
- An approved, live AiSensy document-header campaign with three body
  parameters in this order: invoice number, formatted total, and due date (or
  “On receipt” when the invoice has no due date).
- A customer WhatsApp number with country code in its billing profile. The
  worker queues delivery and updates the invoice status after AiSensy responds.

The WhatsApp provider is optional. Invoice PDF download and manual payment
recording work without AiSensy or R2. This phase does not run recurring billing,
automatic tax calculation from customer location, gateway payments, or plan
feature enforcement.
