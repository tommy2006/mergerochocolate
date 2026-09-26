#!/bin/bash
# Double-click this file in Finder to start Company Scraper.
# The first start sets everything up (about a minute); later starts are quick.
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is needed. Install it from https://www.python.org/downloads/ and try again."
  read -r -p "Press Enter to close."
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First start: setting up Company Scraper…"
  python3 -m venv .venv || { read -r -p "Setup failed. Press Enter to close."; exit 1; }
fi

# install packages on first start and whenever requirements.txt changes
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  echo "Installing packages…"
  if .venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt; then
    touch .venv/.installed
  else
    read -r -p "Installing packages failed. Check the internet connection. Press Enter to close."
    exit 1
  fi
fi

exec .venv/bin/python app.py "$@"
