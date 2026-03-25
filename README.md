# ChatGPT Save Everything

> A one-file, account-safe archive tool for ChatGPT.

This repo contains a single userscript that adds an **Archive Manager** inside ChatGPT. It saves your chats, profile context, and account-specific data into one local `.txt` file, so you can keep a durable backup without spreading your data across multiple files or accounts.

## What It Does

Think of it as a lightweight local archive layer for ChatGPT.

It can:

- Save the current chat on demand
- Sync your full chat history into one archive file
- Capture profile data like custom instructions, About You, and memories where available
- Separate multiple ChatGPT accounts by label, so work and personal archives stay cleanly grouped
- Import archive content back into the currently logged-in account with a guided wizard

## What Makes It Useful

- One file to back up and move around
- No cloud storage dependency
- Built for people who switch accounts and do not want data collisions
- Designed for quick manual saves plus background auto-sync

## Features

- `Save Now` for the current open chat
- `Sync All` for a full backup sweep
- `Sync Profile` for account context refreshes
- `Import Wizard` for restoring archive content into a live account
- Background auto-sync while the tab stays open
- Account labels like `main`, `work`, or `testing`

## Quick Start

1. Install a userscript manager such as Tampermonkey.
2. Add this script:
   - [`ChatGPT-Save-Everything.user.js`](./ChatGPT-Save-Everything.user.js)
3. Open ChatGPT after the script is installed.
4. In the Archive Manager panel, click `Set Account` and choose a unique label for the current login.
5. Click `Choose File` and create or select your archive `.txt` file.
6. Click `Sync All` for the first full backup.

## Suggested Workflow

- First time on an account: `Set Account` -> `Choose File` -> `Sync All`
- Day-to-day use: leave the tab open and let auto-sync do the boring part
- After changing profile details: run `Sync Profile`
- Before switching accounts: use a different label so each archive stays separate

## Requirements

- A Chromium-based browser with File System Access API support
- Chrome or Edge is recommended
- Access to `https://chatgpt.com/*` or `https://chat.openai.com/*`

## Importing Data

Use `Import Wizard` when you want to load an archive file and push content into the current ChatGPT account.

The wizard is especially useful if you:

- Move between accounts
- Want to restore custom instructions or account context
- Need to rehydrate old chats into a fresh session

## Notes

- The archive file stays local unless you move it yourself.
- If ChatGPT changes its internal APIs or UI, the script may need updates.
- This project is not affiliated with OpenAI.

## Project Layout

- `ChatGPT-Save-Everything.user.js` - the userscript itself
- `README.md` - project overview and usage guide
