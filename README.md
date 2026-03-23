# Linked Switches

Sync two or more ON/OFF devices so they always stay in the same state, no matter which one triggers the change.

Perfect for three-way switch setups where multiple physical switches control the same light or group of lights. When any switch in the group is toggled, all others follow instantly.

---

## How to create a group

1. In the Homey app, tap **+** to add a device
2. Select **Linked Switches** from the list of apps
3. Choose **Linked Switch Group**
4. Select the devices you want to synchronize (minimum 2)
5. Give the group a name (e.g. "Staircase", "Guest Room")
6. Tap **Create** — the virtual switch appears in your device list

From that point on, toggling any device in the group (physically or via Homey) will propagate to all others automatically.

---

## Settings (per group)

Each group has its own settings, accessible by tapping the device and going to **Settings**.

| Setting | Description | Default |
|---|---|---|
| **Linked Devices** | List of devices currently in this group | — |
| **Echo Suppress Window** | How long (ms) to ignore echoes after sending a command. Prevents feedback loops. | 2000 ms |
| **Enable Debug Logging** | Write verbose logs to the app console (for troubleshooting) | Off |
| **Notify on Desync** | Send a push notification if a device fails to reach the expected state | On |

---

## Desync Log

The app records all desync events in a global log, accessible via **Configure** on the app page.

Each entry shows:
- **Timestamp** — when the desync was detected
- **Group** — which linked switch group was affected
- **Device** — which physical device failed to sync
- **Expected / Actual** — the state mismatch

Use **Copy to Clipboard** to share the log for troubleshooting, or **Clear Log** to reset it.

### When to check the log

- A device in a group frequently stays out of sync
- You suspect a Zigbee signal issue in a specific room
- After a power outage or router restart

### Common causes

- **Weak Zigbee signal** — the device is at the edge of coverage. Check signal strength in the Homey developer tools.
- **Device offline** — the device was unavailable when the command was sent. It will resync automatically when it comes back online.
- **Interference** — other 2.4 GHz devices nearby can affect Zigbee reliability.

---

## How sync works

- When any device in the group changes state, all others follow
- Echo suppression prevents feedback loops (a device confirming its own command)
- Devices that are offline when a command is sent are queued and synced when they reconnect
- On startup, all devices in the group are automatically aligned to the same state
- A health check runs every 30 seconds to detect accumulated drift

---

## Source

[github.com/gpmachado/gpm.linked.switches](https://github.com/gpmachado/gpm.linked.switches)
