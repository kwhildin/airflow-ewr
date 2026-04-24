import requests
from bs4 import BeautifulSoup

URL = "https://www.newarkairport.com/security-wait-times"

headers = {
    "User-Agent": "Mozilla/5.0"
}

response = requests.get(URL, headers=headers, timeout=15)
response.raise_for_status()

print("STATUS CODE:", response.status_code)

print("\nRAW HTML (first 5000 chars):\n")
print(response.text[:5000])

print("\nCLEAN TEXT (first 2000 chars):\n")
soup = BeautifulSoup(response.text, "lxml")
print(soup.get_text("\n", strip=True)[:2000])