# kibo-insider-lookup
kibo-insider-lookup.js takes a CSV of Insider membership numbers (exported from Google Sheets, with an “Insider ID” column) and finds the matching Kibo customer account by externalId. For each match, it writes the customer’s Billing contact details (first name, last name, address 1, address 2, city, state and ZIP) to an output CSV, along with the Kibo account ID as customerNumber and the account userName as phoneNumber. If an account is found but has no Billing contact, the row keeps the customer’s name and says “no billing address” in the address1 field. If no account matches, firstName says “missing”. Output rows follow the order of the input file. To keep 5,000+ lookups fast, the script sends 25 IDs per request with a few requests running at once, and it retries if Kibo returns rate-limit or server errors. Before the full run it makes one test request to check the credentials and tenant settings, and when it finishes it prints how many rows were matched, had no billing address, were missing, or errored. Connection settings (API host, application key and shared secret, tenant ID and site ID) are read from a .env file.

To execute the program:
> node kibo-insider-lookup.js insiders.csv insider_billing_addresses.csv

Sample output messages of the execution:

◇ injected env (9) from .env
Host https://t42004.tp4.mozu.com | tenant 42004 | site 64487
8423 rows, 7640 unique Insider IDs
7640/7640 looked up
Wrote outputNov23.csv: 663 matched, 997 no billing address, 6763 missing, 0 errored rows (0 failed batches)
