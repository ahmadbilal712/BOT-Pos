# BOT-Pos

A lightweight ERPNext app that **enhances the Point of Sale (POS) Item Selector** and keeps the classic layout.

- Clean **category browser** (Item Groups) with **live item counts**
- **Zero item categories are hidden**
- Breadcrumbs + Back navigation
- Fast, memoized search with **barcode** support (onScan)
- Keyboard shortcuts (Ctrl/⌘ + I → Search, Ctrl/⌘ + G → Item Group)
- **No core file edits** — runs via a POS page hook and a runtime class override

> **Tested on:** Frappe v15 / ERPNext v15

---

## Table of contents

- [What exactly changes?](#what-exactly-changes)
- [Installation (step-by-step)](#installation-step-by-step)

---

## What exactly changes?

###) Category / Item Group browser
- We replace the stock POS *ItemSelector* with a category first browser.
- The **root categories** shown at the top level come from **POS Profile → Filters → Item Groups**  
  (if none are set, we fall back to the POS’ “Parent Item Group”).
- Clicking a folder **drills down**; clicking a group **shows its items**.
- Each tile displays a **badge** with the **number of items** inside that group’s *subtree*  
  (the app looks up all Item Groups under the selected group and counts Items there).
- **Groups with zero items are skipped/hidden** — so cashiers don’t navigate into empty sections.
- A **breadcrumb** at the top and a **Back** button make navigation obvious.

###) Search & Barcode
- Search is **memoized** per price list for snappy feel when the same query is repeated.
- **Barcode scanners** work via the `onScan` library:
  - We **safely detach** any existing listener before attaching ours to avoid the “already initialized” error.
  - Scanning focuses the search input and filters immediately.

---

## Installation (step-by-step)

```bash
# 1) (Optional) backup
bench --site mysite.local backup

# 2) Get the app
bench get-app https://github.com/ahmadbilal712/BOT-Pos.git

# 3) Install on your site
bench --site mysite.local install-app bot_pos

# 4) Build assets, clear cache, restart
bench build --app bot_pos
bench --site mysite.local clear-cache
bench restart

# 5) Uninstall App & Remove
bench --site mysite.local uninstall-app bot_pos
cd /apps
rm -rf bot_pos
