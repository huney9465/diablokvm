# Diablo

A self-hosted web panel for QEMU/KVM virtual machines. Node.js, Express, SQLite and EJS. No build step.

## What's new in this build

- **Port forwarding with a public IP**: reach a NAT VM from the internet. Add rules on the VM page (public IP + port → VM port, TCP or UDP) and the panel turns them into QEMU `hostfwd` options. Each rule shows a ready-to-copy `ssh user@host -p port` command. Duplicate and cross-VM collisions are rejected.
- **Short passwords for admins**: administrators can set a VM login password as short as 3 characters. Regular users still respect the configurable minimum (Settings → Passwords & look).
- **"Created by DiabloKVM" credit**: a credit line shown in the sidebar and on the sign-in pages. Edit the text and optional link in Settings → General.
- **Background image or GIF**: upload a PNG, JPEG, animated GIF or WebP (or paste a URL) in Settings → Background, with a darkening overlay, blur and fixed/scroll options.
- **Discord sign-in from Settings**: configure the Client ID, secret and redirect URI in the panel instead of only `.env`. Environment variables still work as a fallback.
- **More animation and curved, textured buttons**: rounded or fully pill-shaped buttons with a woven texture, hover lift, click ripples and panel reveal animations. Toggle everything under Settings → Passwords & look.

## Features

- **Multiple nodes**: run VMs on as many servers as you like from one panel. Extra servers run a small agent that connects out to the panel, so they need no open ports
- **VM lifecycle**: create, start, shut down (ACPI), power off, reboot, delete, reinstall
- **Cloud-init**: VMs are built from cloud images (Ubuntu, Debian, AlmaLinux, CentOS Stream, Fedora). Hostname, user, hashed password, SSH keys and network are configured on first boot
- **One port**: the panel needs only its own port (8080). VNC and the serial console run over Unix sockets and everything is tunnelled through the panel's WebSocket, so no other port is ever opened
- **Networking**: NAT (outbound internet, no inbound ports) or a bridge with DHCP or a static IPv4 (address, prefix, gateway, DNS), custom MAC addresses and optional VLAN tagging
- **Storage**: copy-on-write disks from a shared base image, grow-only disk resize, ISO library with hot attach and eject
- **Web console**: noVNC in the browser, served through an authenticated bridge (VNC itself listens on 127.0.0.1 only)
- **Browser terminal**: xterm.js. NAT VMs get the VM's serial console, bridge VMs get SSH (with a switch to the serial console)
- **Live serial log** on every VM page
- **Users**: admin and user roles, per-user VM limit, per-VM limits for regular users, optional self-registration, optional Discord sign-in
- **API keys** and a small REST API
- **Admin area**: nodes, users, OS templates (edit URLs, download per node with progress), per-node ISO library, settings, recent activity

## Requirements

- A Linux host with hardware virtualization (`/dev/kvm`). Without it VMs still run, but very slowly
- Node.js 22 or newer
- `qemu-system-x86`, `qemu-utils`, `genisoimage`, `iproute2` and `openssl`
- Root access (QEMU, tap devices and bridges need it)

## Install on Debian or Ubuntu

```bash
unzip kvmpanel.zip && cd kvmpanel
sudo bash install.sh
```

The script installs the packages and Node.js 22, copies the panel to `/opt/kvmpanel`, and starts it as the `kvmpanel` systemd service on port 8080.

On a brand new install it also asks for the admin **username**, **email** (optional) and **password**
(leave the password blank for a random one), and whether to turn on **self-registration** so other
people can create their own accounts from the sign-in page. It then creates that admin account and
prints the credentials before the service starts. Re-running the installer on top of an existing
`.env` skips these questions and leaves the existing admin account alone. If the script isn't run
from an interactive terminal, it falls back to the defaults in `.env.example` (username `admin`,
random password, self-registration off) — set `ADMIN_USERNAME`/`ADMIN_PASSWORD`/`ADMIN_EMAIL` in
the environment beforehand if you need to script a non-interactive install.

### Manual install or development

```bash
npm ci --ignore-scripts   # better-sqlite3 ships prebuilt binaries, no compiler needed
cp .env.example .env      # set DATA_DIR to a folder you can write to
npm start
```

If Node cannot load `better-sqlite3` on an unusual platform, run `npm rebuild better-sqlite3` (needs a C++ compiler and Python).

## First steps

1. Sign in and open **OS templates**. Click **Download** on the images you want. Vendors rename files now and then. If a download returns 404, click **Edit**, paste the current image URL and download again
2. Open **Create VM**, pick an OS, set the size, choose a login and create it
3. Press **Start**. The first boot takes a minute or two while cloud-init configures the machine. Watch the log on the VM page
4. Use **Console** for the screen or **Terminal** for SSH

## Locked out / "Wrong username or password"

The admin account is only ever seeded once, the moment the database is first created. Setting
`ADMIN_USERNAME`/`ADMIN_PASSWORD` later, or reinstalling on top of an old `DATA_DIR`, has no effect
on an account that already exists — so if the panel was ever installed before (or upgraded on top
of an existing database), "admin / admin" may not be the real password any more, and there was
previously no way back in short of editing the database by hand.

Run this on the server, from the panel's folder, while the panel is running or stopped:

```bash
npm run reset-admin                                   # resets ADMIN_USERNAME to ADMIN_PASSWORD (or a random one)
npm run reset-admin -- bob                            # resets user "bob" to a random password, makes it admin
npm run reset-admin -- bob newpassword                # resets user "bob" to a chosen password
npm run reset-admin -- bob newpassword bob@example.com # also sets/updates the account's email
```

If `bob` doesn't exist yet, the same command creates it fresh as an admin — this is also how to
create additional admin accounts from the command line, not just recover the original one.

It prints the resulting username, email (if set) and password, and takes effect immediately — no restart needed.
The panel also now self-heals on startup: if every admin account is missing, deleted or disabled,
a fresh one is created (or an existing account with the same username is repaired) and the
credentials are printed to the log, the same way they are on a genuine first run.

## Multiple nodes

The server that runs the panel is always a node called **Local**. You can add more servers, and the panel places VMs on them.

**How it works.** Each extra server runs the node agent (`src/agent.js`). The agent opens one WebSocket **to the panel** (`/ws/node`, on the panel port) and keeps it open. Commands, the VNC and serial consoles, SSH terminals and log streams all travel through that connection, so:

- the panel still needs only its own port
- nodes need **no inbound ports** and can sit behind NAT or a firewall, as long as they can reach the panel
- if a node or the link drops, the agent reconnects by itself

**Add a node** (modelled on Pterodactyl's node setup)

1. **Administration > Locations**: optionally add locations (a code such as `fra`, plus a description) to group your nodes
2. **Administration > Nodes > Add node**: name, location, and resources. Set a memory and disk limit for the VMs the node may hold, each with an over-allocation percentage (0 = none, 50 = 150% of the limit, -1 = unlimited). A limit of 0 uses whatever the node reports
3. The next screen is the node's **Configuration** tab with an **auto-deploy** command. On the new server (Debian or Ubuntu, root) run it:

   ```bash
   curl -fsSL https://panel.example.com/node-deploy/<code> | sudo bash
   ```

   The link works **once** and expires after 15 minutes. It installs QEMU, Node.js and the agent, writes `/etc/diablo-node/config.yml`, and starts the `kvmpanel-node` service. The agent files come from the panel itself, so the node needs nothing but network access to the panel
4. The node shows as **Online** within a few seconds
5. Open **OS templates** and download the images you want onto the node (choose the node, or "All nodes missing it")

**Manual setup.** On the Configuration tab, "Generate configuration" issues a new token and shows a `config.yml` (like a Wings config). Save it as `/etc/diablo-node/config.yml`, or run `sudo bash install-node.sh --panel URL --token TOKEN` from the extracted project folder, which writes it for you. The file is flat `key: value` lines: `panel_url`, `token`, `data_dir`. Environment variables (`PANEL_URL`, `NODE_TOKEN`, `DATA_DIR`) override it.

Either option issues a **new token** and disconnects an agent that is already using the old one.

**The node page** has four tabs: **About** (status, system information, allocation against the limits), **Settings** (details, location, limits, maintenance mode, delete), **Configuration** (deploy command and manual setup) and **Servers** (the VMs on the node).

Each node keeps its **own** OS images and ISO files (`DATA_DIR` on that server). Templates and the ISO library pages show and manage them per node.

**Placement**

- Admins pick a node when creating a VM, or choose automatic
- Regular users never see nodes. Their VMs go to the enabled, online node that has the chosen OS, has room within its memory and disk limits, and has the lowest memory allocation relative to its limit
- Limits are enforced whenever a VM is created, given more memory, or given a bigger disk. Shrinking is always allowed
- Per node you can turn off "Place regular users' VMs here" (admin-only nodes) or "Accept new VMs" (maintenance mode). Existing VMs keep running either way

**When a node goes offline**

- Its VMs keep running: they are ordinary QEMU processes on that server
- The panel shows their state as "Node offline" and disables power controls and consoles until the node reconnects
- VMs flagged **Start when the panel starts** are started by the agent after the node itself reboots, even if the panel is unreachable

**Limits**

- A VM lives on the node it was created on. There is no live migration
- Deleting a VM needs its node online, and a node that still hosts VMs cannot be removed
- Limits are about what has been *allocated*, not what is in use: memory is checked against allocations, and a VM's disk counts at its full size even though disk images grow lazily
- Use an `https://` panel address. The node token, terminal passwords and console traffic cross that connection. The deploy command also travels over it, so an `http://` panel would send the node token in the clear
- Rotating a token (Nodes > New token) disconnects the agent until you give it the new token

## Networking

**NAT (default).** No host setup. The VM reaches the internet through the host, and nothing on the host is opened for it. Use the **Terminal** button to get a shell: it attaches to the VM's serial console through the panel. Cloud images normally run a login prompt on the serial port, so press Enter and sign in with the VM's user and password. Only one person can hold the serial console at a time. If you need real SSH into a VM, use a bridge VM.

**Bridge.** The VM gets its own address on your LAN. Create the bridge on the host first. Example for Ubuntu with netplan (adjust the interface name and addresses, and be careful when doing this over SSH):

```yaml
network:
  version: 2
  ethernets:
    eno1: {}
  bridges:
    br0:
      interfaces: [eno1]
      dhcp4: true
```

Then choose **Bridge** when creating a VM as an admin. Leave the IPv4 field empty for DHCP, or fill in address, prefix, gateway and DNS for a static setup. For VLANs the bridge needs VLAN filtering turned on (`ip link set br0 type bridge vlan_filtering 1`).

Static addressing and VLANs are set at creation or reinstall. Cloud-init only applies network settings on a VM's first boot.

## Configuration

Everything is optional. See `.env.example` for all variables. The important ones:

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST` | Where the panel listens (default 0.0.0.0:8080) |
| `DATA_DIR` | Database, VM disks, images, ISOs (default `/var/lib/kvmpanel`) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | First-run admin (random password printed if empty) |
| `SECURE_COOKIES`, `TRUST_PROXY` | Set both to `true` behind an HTTPS reverse proxy |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` | Enable Discord sign-in (can also be set in **Settings → Discord sign-in**) |

Panel behaviour (default networking for regular users, limits, registration) is edited in **Settings**.

## Ports

| Port | Purpose |
| --- | --- |
| 8080 | Panel, web console, terminal and logs (`PORT` in `.env`) |

That is the only TCP port the panel or any VM listens on. Extra nodes listen on nothing: they only make an outbound connection to the panel. VNC and the serial console are Unix sockets inside `DATA_DIR/vms/<id>/`, and bridge VMs have their own IP on your LAN (the panel only connects out to them for SSH).

## Data layout

```
DATA_DIR/
  panel.sqlite          users, VMs, templates, settings
  templates/            downloaded base images
  isos/                 ISO library (you can copy files here too)
  vms/<id>/             disk.qcow2, seed.iso, qemu.pid, qmp.sock, vnc.sock, console.sock, serial.log
  known-vms.json        (nodes only) the agent's list of its VMs, used to autostart after a reboot
```

This layout is the same on the panel host and on every node (nodes default to `/var/lib/kvmpanel-node`). VMs are daemonized QEMU processes. Restarting or stopping the panel does not stop them. VMs marked **Start when the panel starts** are booted when the panel comes up.

## API

Create a key under **Profile and API keys**, then:

```bash
curl -H "Authorization: Bearer kvmp_..." https://panel.example.com/api/v1/vms
curl -X POST -H "Authorization: Bearer kvmp_..." https://panel.example.com/api/v1/vms/1/start
```

Endpoints: `GET /api/v1/vms`, `GET /api/v1/vms/:id`, `POST /api/v1/vms/:id/{start,stop,reboot,force-stop}`.

## Security notes

- Put the panel behind HTTPS (Caddy or nginx) and set `SECURE_COOKIES=true` and `TRUST_PROXY=true`. WebSocket upgrades must be forwarded
- Nodes trust the panel completely: it can run VMs and read their consoles on every node. Treat panel admin access, and the panel host, accordingly. A leaked node token only lets someone impersonate that one node
- Node tokens are stored hashed. The guest password is hashed on the panel before it is sent to a node
- The panel and QEMU run as root. Only give admin accounts to people you trust with the host
- Passwords typed into the browser terminal pass through the panel to reach the VM. Use HTTPS
- The SSH terminal can only reach the VM it was opened for, so it cannot be used to reach other machines on your network. A DHCP bridge VM has no known address, so only admins can point the terminal at it
- Guest passwords are stored only as SHA-512 hashes on the cloud-init seed image. Reinstall to set a new one
- VNC and the serial console live on root-only Unix sockets, so a fresh install exposes a single TCP port
- Regular users cannot choose networking or owners, so they cannot claim IP addresses or create VMs for others
- All forms use CSRF tokens, and WebSockets check the session and the Origin header

## Project layout

```
src/server.js          app bootstrap, sessions, security headers
src/routes/            auth, dashboard, vms, profile, admin, api
src/services/nodes.js  node registry, tunnel protocol, VM placement
src/services/vmdata.js VM records, validation, quotas
src/host/              everything that touches a machine's VMs: QEMU, QMP, disks,
                       cloud-init, images, console streams (shared by panel and agent)
src/agent.js           the node agent (reads /etc/diablo-node/config.yml via agent-config.js)
src/routes/deploy.js   serves the one-line node installer and the agent bundle
src/ws/index.js        browser console bridges and the /ws/node endpoint
views/                 EJS templates
public/                CSS and browser scripts
```

## Known limits

- x86_64 guests only
- Nodes must be Debian or Ubuntu to use `install-node.sh`. Other distributions work if you install QEMU and Node.js 22 yourself and run `node src/agent.js` with `PANEL_URL`, `NODE_TOKEN` and `DATA_DIR` set
- The serial console needs a getty on the serial port inside the guest. Standard cloud images have one. Custom images may not
- `DATA_DIR` must be a short path (Unix socket paths are limited to about 100 characters)
- Disks can grow but not shrink
- CPU and memory changes apply on the next full stop and start
- Cloud images are downloaded as-is. Verify checksums yourself if that matters to you
- There is no built-in backup or snapshot feature. Copy `DATA_DIR/vms/<id>` while a VM is stopped
