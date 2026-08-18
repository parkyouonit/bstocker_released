# bStocker laptop run

1. Install the current Node.js LTS release on the laptop.
2. Copy this entire folder to any location on the laptop.
3. Double-click `RUN_BSTOCKER_4174.bat`.
4. On the same laptop, open `http://localhost:4174`.
5. On another device in the same network, open `http://<laptop-LAN-IP>:4174`.

The launcher resolves all paths relative to its own folder, so the drive letter and parent folders may change. It installs dependencies when needed, creates a production build, and starts the web app on fixed port `4174` plus its private API on `8787`. It never uses port `4173`. Press `Ctrl+C` in the server window to stop both processes.

## Robinhood automation when moving PCs

- The Keeper key is protected by Windows DPAPI for the Windows user that created it. Copying `.secrets\robinhood-keeper.dpapi.json` to another laptop does **not** make that key usable there.
- To keep the same Keeper, extract its private key on the old PC, copy it to the new PC clipboard, and run `IMPORT_KEEPER_FROM_CLIPBOARD.bat`. The importer requires the key to match the copied Keeper address, re-encrypts it with the new Windows user's DPAPI, preserves the old encrypted file as a backup, and clears the clipboard.
- Never paste the key into chat, Git, logs, `.env.local`, or `work/`. If the original key is unavailable, create a new low-privilege Keeper with `npm.cmd run keeper:prepare` and update the Vault Keeper through the owner wallet.
- If a Vault was already deployed, open `RH 3-TICK` with the owner Rabby and use `Rabby로 이 PC의 새 Keeper 등록`. Then send the new Keeper a small ETH gas balance and sign `ARM` again.
- Set `ROBINHOOD_AUTOMATION_OWNER` in `.env.local` to the same owner Rabby address. The public server remains fail-closed when that value is absent or different.
- A laptop that is sleeping, powered off, disconnected, or no longer running 4174/API/Keeper cannot rebalance. Use a dedicated Robinhood RPC for unattended operation; the public RPC is rate-limited.

Cloudflare Tunnel credentials are intentionally not included. To reuse the public domain on the laptop, install `cloudflared`, copy the existing tunnel config and credential JSON separately, correct their local paths, stop the old desktop connector, and then start the connector on the laptop.
