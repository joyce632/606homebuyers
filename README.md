# 606 Home Buyers: seller site (sample)

A static redesign of the seller-facing site at 606homebuyers.com. Plain HTML, CSS and JS with no build step. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000 --directory seller-site
```

Before going live:
- The offer form is a demo. In `app.js`, send the `lead` object to a form service or CRM webhook in the submit handler.
- Replace the reviews with verified Google reviews.
- Confirm the phone number. The current site lists both (773) 570-2800 and (847) 721-0118; this sample uses the 773 number.
