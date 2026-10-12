# 606 Home Buyers: seller site (sample)

A static redesign of the seller-facing site at 606homebuyers.com. Plain HTML, CSS and JS with no build step. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000 --directory seller-site
```

Live preview (GitHub Pages, served from the `gh-pages` branch): https://joyce632.github.io/606homebuyers/

To publish changes after committing on `redesign`:

```bash
git push origin "$(git subtree split -q --prefix seller-site HEAD)":refs/heads/gh-pages
```

Before going live:
- The offer form is a demo. In `app.js`, send the `lead` object to a form service or CRM webhook in the submit handler.
- Add the owners' names and titles in the "Our team" section (`index.html`, search for "Co-owner").
- The reviews, the 4.9 rating and the "As seen on" logos are carried over from the current site. Keep them only if they can be verified.
- Confirm the phone number. The current site lists both (773) 570-2800 and (847) 721-0118; this sample uses the 773 number.
