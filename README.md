# Linked Switches

Linked Switches sync 2 to 10 ON/OFF devices so they always stay in the same state, no matter which one triggers the change.

Perfect for three-way switch setups where multiple physical switches control the same light or group of lights. When any switch in the group is toggled, all others follow instantly.

For setups where one switch is wired directly to the load while the others are just helpers, you can optionally mark one device as **Primary**. The Primary device is controlled first; the remaining devices follow with a tiny stagger to keep your Zigbee network calm.

For scene-style control, **Switch Master** uses 1 master and 2 to 9 subdevices. The master can override the slaves, but the slaves keep their individual control. When all slaves reach unanimity, the master syncs back if it was out of step.

---

## Drivers At A Glance

This app ships with two different drivers:

- **Linked Switch Group** (`switch-sync`) keeps 2 to 10 devices in a closed sync group, with an optional Primary device.
- **Switch Master** (`switch-master`) uses 1 master and 2 to 9 slaves for scene-style control.

They solve different problems:

- `switch-sync` is for devices that should always mirror each other.
- `switch-master` is for a master switch that can toggle a set of slaves, while still allowing manual control of the slaves and syncing back on unanimity.

The UI also follows that split:

- Linked Switch cards can show subdevice status and desync warnings.
- Switch Master cards can show optional subdevice status, but the clickable controls are usually the main view.

---

## How to create a group

1. In the Homey app, tap **+** to add a device
2. Select **Linked Switches** from the list of apps
3. Choose **Linked Switch Group**
4. Select the devices you want to synchronize (minimum 2)
5. Optionally mark one device as **Primary** — usually the switch wired directly to the light or outlet
6. Give the group a name (e.g. "Staircase", "Guest Room")
7. Tap **Create** — the virtual switch appears in your device list

From that point on, toggling any device in the group (physically or via Homey) will propagate to all others automatically, with the Primary device acting first.

---

## Association rules

The app supports two association models, and each one has its own rule set:

### Linked Switch groups

- A Linked Switch group is closed: devices inside it stay synchronized with each other.
- A physical device can belong to only one Linked Switch group.
- You cannot build a chain of Linked Switch groups.
- If you want to extend a Linked Switch group, use **Repair** on that same group and add the new device there.
- You can optionally mark **one** device as Primary. It is controlled first; the rest follow with a small stagger.
- Leave Primary unset if all devices are indirect (e.g. Hue lamps controlled through wall switches).
- The `show_device_status` app setting controls whether Linked Switch cards show live status or only the device names.

### Switch Master groups

- A Switch Master has one `master` device and 2 to 9 `slave` devices.
- The `master` device cannot be the `master` of another Switch Master.
- The `master` device cannot belong to a Linked Switch group.
- A `slave` device can be a member of a Linked Switch group.
- The `master` follows the slaves only when they all agree on the same state.
- In practice, that means you can use a Linked Switch group member in the same Switch Master, but only one member from that linked group to avoid redundancy.
- A Switch Master may trigger a Linked Switch device, and the Linked Switch will still keep its own members in sync.
- The `show_master_status` app setting controls whether Switch Master cards show live status for each subdevice.

### Practical examples

- `D-E` is a valid Linked Switch group.
- `E-F` is not allowed if `D-E` already exists; expand `D-E` through Repair instead.
- `A -> D -> E` is valid when `A` is a Switch Master and `D-E` is a Linked Switch.
- `A -> D -> E -> F` is not allowed when `D-E-F` are all members of the same Linked Switch group, because that would duplicate the same linked group inside the same Switch Master.
- `B` cannot become the master of another Switch Master if `B` is already used as a Switch Master master.
- In a Linked Switch group `Corredor-lnk` with devices `Corredor`, `Corredor Aux1`, `Corredor Aux2`, you can mark `Corredor` as Primary. When any auxiliary is toggled, `Corredor` is controlled first.

### What Is Excluded

- No cascaded Linked Switch groups.
- No shared members between two Linked Switch groups.
- No second Switch Master using a device that is already a Switch Master master.
- No Switch Master that contains more than one device from the same Linked Switch group.
- No need to re-pair a device just to expand an existing Linked Switch group: use **Repair** on the group instead.

## Settings (per group)

Each group has its own settings, accessible by tapping the device and going to **Settings**.

| Setting | Description | Default |
|---|---|---|
| **Linked Devices** | List of devices currently in this group | — |
| **Echo Suppress Window** | How long (ms) to ignore echoes after sending a command. Prevents feedback loops. | 2000 ms |
| **Auto-Heal Desynced Devices** | Automatically retry setting a desynced device to the expected state (20 s cooldown per device) | Off |
| **Notify on Desync** | Send a push notification if a device fails to reach the expected state | On |

### When to enable Auto-Heal

Auto-Heal is **off by default** because retrying a device that keeps failing can mask a real problem (weak signal, dead device) instead of surfacing it.

Turn it on when you have a device that drops commands intermittently but is otherwise healthy — for example a Zigbee/Tuya switch that occasionally times out. Auto-Heal will re-send the expected state (max once every 20 s per device) until it sticks. Leave it **off** while diagnosing a new or unreliable device, so the Desync Log shows the failures clearly.

---

## Boot Sync Policy

A global setting (app **Configure** page) for **Linked Switch** groups. It decides which state wins when Homey starts, for example after a power outage, when devices may come back in different states:

| Policy | What happens at startup |
|---|---|
| **Keep group state** (default) | The group's last saved ON/OFF state is written to every device that differs from it when the app starts. |
| **Any ON wins** | If any device in the group is ON, the group becomes ON and the rest are turned ON. |

Notes:

- The policy only applies at startup, and only to devices whose state is already known to differ then. A device that reports its state after startup is handled as a normal change.
- A re-subscription by the health check only re-attaches listeners: it never changes a device or the group. **Repair** aligns the devices to the group's saved state.
- A group that has no saved state yet (just created) adopts its devices' state, whichever policy is set.
- With **Keep group state**, a wall switch flipped while Homey was down is reverted to the group's saved state.
- Switch Master groups are not affected.

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
- If a Primary device is configured, it is controlled first; remaining devices follow with a small stagger to reduce Zigbee congestion
- Echo suppression prevents feedback loops (a device confirming its own command)
- Rapid duplicate callbacks from the same device are debounced before propagating
- Devices that are offline when a command is sent are queued and synced when they reconnect
- On startup, all devices in the group are automatically aligned to the same state (see [Boot Sync Policy](#boot-sync-policy))
- A health check runs every 10 minutes, and immediately after a failed sync, to detect accumulated drift

---

## Flow cards

The Flow cards below are **deprecated**: they no longer appear when creating new Flows, but Flows that already use them keep working. Sync recovery is automatic (startup and re-subscribe alignment, health check every 10 minutes, optional Auto-Heal), and failures are shown in the Desync Log and, if enabled, as a push notification.

- **Trigger — "A device failed to sync"** — fires when a device fails to reach the expected state. Tokens: device name, expected state, actual state.
- **Condition — "Group is fully synced"** — true when every device matches the group state (no pending failures or offline devices).
- **Action — "Force resync"** — re-sends the current group state to all devices.

---

## Source

[github.com/gpmachado/gpm.linked.switches](https://github.com/gpmachado/gpm.linked.switches)
