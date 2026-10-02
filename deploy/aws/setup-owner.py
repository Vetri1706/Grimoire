"""Private first-owner setup, run interactively on the deployment host."""
import getpass
import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8080/api"
with urllib.request.urlopen(BASE + "/setup/status", timeout=5) as response:
    if not json.load(response)["setup_required"]:
        raise SystemExit("Installation owner already exists; no account changed.")

login = input("Owner login name: ").strip()
display = input("Owner display name: ").strip()
password = getpass.getpass("New passphrase (not displayed): ")
if password != getpass.getpass("Confirm passphrase: "):
    raise SystemExit("Passphrases did not match; nothing submitted.")
payload = json.dumps({"login_name": login, "display_name": display, "passphrase": password}).encode()
request = urllib.request.Request(BASE + "/setup/owner", data=payload, method="POST", headers={
    "Content-Type": "application/json", "X-Grimoire-CSRF": "1"
})
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status != 201:
            raise SystemExit("Unexpected setup response; inspect the private API logs.")
except urllib.error.HTTPError as error:
    raise SystemExit(f"Setup was refused (HTTP {error.code}); no credentials were printed.") from None
print("Installation owner created. Sign in using the public HTTPS URL.")
