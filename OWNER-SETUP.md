# What's needed to go live

Everything here needs the owner's (or Luke's) own accounts, cards or details. The code is done; these are the switches to flip.

## 1. Shop details (5 minutes)

In `config/shop.json`, replace every `PLACEHOLDER`:
- street address and the phone number customers should ring
- barber name(s)
- real prices, service lengths and opening hours (the ones there now are guesses)

## 2. Photos (10 minutes)

Instagram doesn't allow automated downloads. From the owner's phone or instagram.com/athlonebarberclub, save 8 of the best photos and put them in `public/images/gallery/` named `1.jpg` to `8.jpg`. The shopfront photo at the top of the site is already in place (`public/images/hero.jpg`); a bigger original of it would look sharper on large screens.

## 3. Hosting and domain

- A host account (Render is set up via `render.yaml`; it needs a paid plan so the diary is kept on a disk).
- A domain, e.g. athlonebarberclub.ie (.ie domains need a connection to Ireland, which the shop has).
- Set `PUBLIC_URL` to that domain and pick a long `ADMIN_PASSWORD`.

## 4. Anthropic account (the AI that talks on the phone)

- Sign up at console.anthropic.com, add a card, create an API key, set it as `ANTHROPIC_API_KEY`.
- Billing is per call based on usage. The default model is `claude-opus-5-5`. Set `AGENT_MODEL` to change it.

## 5. Twilio account (the phone line, texts and voice)

- Sign up at twilio.com and upgrade from trial (trial accounts play a message before every call).
- Buy an Irish phone number with voice and SMS. Irish numbers need a regulatory bundle (proof of a business address in Ireland), which Twilio walks you through.
- Turn on ConversationRelay for the account if the console asks (Voice > ConversationRelay), and accept the AI/ML features addendum.
- On the number, set "A call comes in" to Webhook, `https://YOUR-DOMAIN/voice/incoming`, HTTP POST.
- Copy the Account SID, Auth Token and number into `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.
- Check the per-minute, per-number and per-text prices on Twilio's Ireland pricing page so the owner knows the running cost against Fresha or Booksy fees.

## 6. Decide how calls reach the AI (pick one)

**A. Keep the number customers already know (recommended).** If the shop number is the owner's mobile, set his phone's "forward when unanswered" and "forward when busy" to the Twilio number (ask the mobile network, or dial the operator's divert code). Set `RING_OWNER_FIRST_SECONDS=0`. He answers when he can; the AI gets everything else.

**B. Publish the Twilio number as the shop number.** Set `OWNER_MOBILE` and `RING_OWNER_FIRST_SECONDS=15` so his mobile rings first. His voicemail must take longer than 15 seconds to kick in, or voicemail will answer instead of the AI.

Either way, set `OWNER_MOBILE` so the AI can put callers through and text him new bookings and messages.

## 7. Try it

1. Book on the website and check the text arrives.
2. Ring the number, book a fade, then ring again and cancel it.
3. Ask the AI for the owner and check the transfer.
4. Open `/admin` and check all three show up.

## Moving off Fresha / Booksy

Copy future appointments into `/admin` (or have the AI book them), then switch the "Book" links on Instagram and Google Business Profile to the new site. Keep the old account until the last booking made there has passed.
