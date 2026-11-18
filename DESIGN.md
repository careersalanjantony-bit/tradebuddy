# Neo-Luminous Fintech (Odie App) — Design System (`DESIGN.md`)

## 1. Visual Direction & Aesthetic
- **Theme Name:** Neo-Luminous Fintech
- **Form Factor:** Mobile Native iOS / Android (390px base width)
- **Design Philosophy:** Crisp, airy light-mode baseline with high-contrast tactical dark elements, soft luminous mint/emerald accents, rounded containers, and modern financial typography.

---

## 2. Color Palette & Tokens

### Surface & Background Tokens
- `surface-canvas`: `#F9F9FF` (Soft ultra-light cool tinted canvas)
- `surface-card`: `#FFFFFF` (Pure white primary card background)
- `surface-container-low`: `#F0F3FF` (Subtle tinted section grouping)
- `surface-container-high`: `#E2E8F0` (Muted borders and separators)
- `surface-dark-card`: `#111827` to `#1F2937` (Dark high-contrast feature cards, e.g. "Trade Smarter, Not Harder")

### Brand & Accent Tokens
- `brand-mint-primary`: `#10B981` (Vibrant emerald/mint for positive metrics, key badges, primary toggles)
- `brand-mint-subtle`: `#D1FAE5` / `#E6FBF2` (Light pastel green background for "Deposit" CTA pill)
- `accent-interactive`: `#1E293B` (Primary action button dark pill: "Buy", "Trade", "Explore Markets")

### Market Status Colors
- `trend-bullish-green`: `#10B981` / `#059669` (Gains, positive candlestick bars, percentage pills)
- `trend-bearish-red`: `#EF4444` / `#DC2626` (Losses, negative candlestick bars, percentage indicators)
- `neutral-gray`: `#64748B` / `#94A3B8` (Inactive tabs, secondary metadata, timestamps)

---

## 3. Typography & Hierarchy

- **Primary Font Family:** `Plus Jakarta Sans`, `-apple-system`, `BlinkMacSystemFont`, `Inter`, sans-serif
- **Hero Balance / Big Numerals:**
  - Font Size: `32px` - `36px`
  - Font Weight: `700` (Bold) / `800` (Extra Bold)
  - Letter Spacing: `-0.02em`
- **Section Headers & Screen Titles:**
  - Font Size: `18px` - `20px`
  - Font Weight: `600` (Semi-bold)
- **Token / Asset Ticker & Primary Labels:**
  - Font Size: `15px` - `16px`
  - Font Weight: `600`
- **Body & Secondary Captions:**
  - Font Size: `12px` - `13px`
  - Font Weight: `500` / `400`
  - Color: `#6B7280`

---

## 4. Layout & Spacing Rules

- **Corner Radii:**
  - Standard Cards: `16px` to `20px` (`rounded-2xl`)
  - Action Pills & Badges: `9999px` (`rounded-full`)
  - Icon Quick Action Tiles: `14px` (`rounded-xl`)
- **Spacing Grid:**
  - Base Unit: `4px`
  - Screen Padding: `16px` or `20px` horizontal gutter
  - Card Internal Padding: `16px` to `20px`
  - Element Gap: `8px` (compact) / `12px` - `16px` (standard)

---

## 5. Component Patterns

### Top Bar & Navigation Chrome
- Centered or left-aligned brand lockup (`Odie` logomark + wordmark)
- Right action buttons (Notification bell icon button in circular boundary)
- Dynamic Island / status bar offset integration (`pt-12`)

### Wallet Value Hero Card
- Subtle mint radiant gradient background (`from-emerald-50/60 to-transparent`)
- Total balance display with eye visibility toggle icon
- Month-over-month performance pill (`▲ 2.9% (+$8,320) last month`)
- Two-column pill actions: `+ Deposit` (soft green) and `↑ Withdraw` (outlined/neutral)

### 4×2 Quick Utility Grid
- 8 feature shortcuts: `Earn`, `Auto DCA`, `Price Alert`, `Referral`, `Reward`, `Academy` (with badge), `History`, `Others`
- Minimalist line icons housed in soft elevated rounded squares with micro-labels below

### Watchlist & Top Movers
- Asset row: circular coin icon + Coin Name / Symbol + Sparkline + Current Price + % pill badge
- Horizontal carousel for "Top Movers" featuring Dogecoin, Cardano, etc., with sparkline chart previews

### Docked Bottom Navigation Bar
- 5 items: `Home`, `Markets`, `Trade` (Prominent elevated center circle with swap icon `⇄`), `Discover`, `Portfolio`
