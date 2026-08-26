# Shared Ola Ink UI shell

`olaink.css` is the shared visual foundation for the marketing site and the
self-hosted inbox: design tokens, base reset/focus behavior, and the Ola Ink
header/brand/navigation classes.

`templates.mjs` supplies the matching static header and navigation-link
fragments. Callers pass only first-party, static navigation markup; never pass
user-controlled content to `olaInkHeader({ navigation })`.

The Astro site imports the stylesheet directly. `scripts/embed-onboard-page.mjs`
inlines the same stylesheet and header into the server's compiled onboarding
page, and copies the canonical logo into the standalone server binary.
