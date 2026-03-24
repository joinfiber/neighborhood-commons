# Portal Design Document

A world-class UI on top of a database. Nothing invented — just exquisitely executed.

---

## What This Is

The portal is a multi-tenant CMS for entering and managing neighborhood event data. It serves two user types:

1. **Business users** — bar managers, yoga studio owners, coffee shop staff, venue operators. They post events for their business. They have 5 minutes. They may never have used a CMS. The portal must be immediately legible, anchoring, and fast.

2. **Admin** — the platform operator. Enters data from the field, manages ingestion pipelines, reviews candidates, curates the dataset. Needs speed and power. The same interface, but used differently.

Both users interact with the same screens. The admin has additional screens (review queue, ingestion sources, account management) that business users never see.

---

## Design Principles

### 0. Sturdy, fast, self-reflective

The portal must feel like a native application. Blisteringly fast. Essentially bug-free. No loading screens that break the flow, no layout shifts that undermine trust, no state that drifts from the source of truth. When a user enters data here, they should feel the solidity of it — this information is going to many places, and what they see is exactly what exists.

**Self-reflective data presentation:** Every piece of data presents in accordance with its nature. A title always renders as a title — prominent, singular, the name of the thing. A category always renders as a category — a label from a known set, visually distinct from free text. A date always reads as a date. A venue always reads as a venue. The UI doesn't just display data accurately; it communicates what each piece of data *is*. A user looking at any screen can instantly distinguish the title from the description from the category from the time — not because they read the labels, but because each data type has a consistent visual identity across every screen and context where it appears.

This is what makes the tool feel durable. The user trusts it because it's coherent. The same event looks the same on the dashboard, in the edit form, in the review queue, and in the API response. The presentation is the data's nature made visible.

**The opposite of showy.** No cinematic transitions, no elements that change shape or slide into view for dramatic effect. Things appear because they exist. Things change because the data changed. Every visual behavior is a direct consequence of state, not decoration.

**Research mandate:** At each juncture — every significant component, every interaction pattern — spend real time researching how the best tools solve that specific problem. Not for inspiration to copy, but for evidence of what actually helps people feel at ease and in control. Every design choice should be defensible with "this is the best known way to handle X," not just "this looks right."

### 1. Everything visible, nothing hidden

The form shows all fields. Optional fields are visually lighter but present. No progressive disclosure through toggles — no "+ Add tags" that reveals a section, no "Show advanced" that expands a drawer. The user sees the full scope of what's being asked in a single glance.

**Why:** Hidden fields create anxiety ("what am I missing?") and cognitive overhead ("should I expand this?"). A user who can see the whole form in 3 seconds knows exactly what's expected. The form is short enough that nothing needs to be hidden.

### 2. Pre-filled only from explicit account data

The user's venue name and address come from their account profile — data they explicitly set during onboarding. That's it. No history-based defaults, no "smart" suggestions, no predictive features. Every other field starts blank or at a neutral default.

**Why:** Anticipating user needs feels flimsy and muddies the experience. Users know what they're doing when they sit down at a tool like this. Inserting opinions about what they probably want is unhelpful, introduces bugs, and creates a less durable experience. Simplicity and clarity beat cleverness.

### 3. Contextual help on every non-obvious field

Optional and potentially ambiguous fields get a small `ⓘ` icon. Tapping or hovering reveals a tooltip — one or two sentences explaining what the field is for, what kind of input is appropriate, and why it matters.

These are not help docs. They're gentle confirmations that reduce the anxiety of "am I filling this out correctly?" A user who never touches a tooltip should still understand every field. A user who taps every tooltip should feel more confident, not more confused.

### 4. Category is user-chosen, never inferred

Category is a required field. The user picks it. We don't guess based on the title or venue type. The business owner has skin in the game — the wrong category sends the wrong crowd and misses the right one. They care about getting it right, and they're the best judge.

### 5. The dashboard is a programming schedule

Business owners think in terms of their recurring programming (trivia every Tuesday, open mic every Thursday) and their upcoming specials (that one show next Saturday). The dashboard reflects this mental model: recurring programs, upcoming one-offs, and a history. Not a flat grid of individual events.

### 6. Gorgeous, not flashy

Premium visual quality. Considered spacing, typography, and hierarchy. No decorative elements, no animations for their own sake, no gradients or shadows that don't serve legibility. The goal is a tool that feels calm, confident, and expensive — like it was designed for someone who matters.

---

## The Event Form

### Layout

A single scrollable page. No tabs, no steps, no wizard. Everything visible at once, organized in natural reading order: what → when → where → what kind → how it looks → what to know → how much → where to learn more.

A subtle visual divider separates the essentials (title, date/time, venue, category) from the enrichment (image, description, price, link). The essentials feel mandatory through visual weight. The enrichment feels inviting but clearly optional.

### Fields

#### Title
- Full-width text input
- Prompt: "What's happening?"
- Required
- No tooltip needed — self-evident

#### Date and Time
- Date picker and start time picker, side by side
- End time picker below or beside, with clear "optional" treatment
- End time tooltip `ⓘ`: "When does this end? Useful for things like happy hours, open studio time, or shows with a set run."
- Clean, obvious controls. The date picker should feel like tapping a date on a calendar. The time picker should feel like setting an alarm.

#### Recurrence
- Toggle: "One-time" / "Repeats"
- If "Repeats": frequency selector (Every week / Every two weeks / Every month / Custom days)
- Duration: "How long?" with presets — 3 months, 6 months, 1 year
- Below: a plain-language summary: "Every Tuesday for 6 months — 26 events, Apr 1 – Sep 30"
- Recurrence tooltip `ⓘ`: "Set this up once and all future dates are created automatically. You can always edit or cancel individual dates later."

#### Venue
- Pre-filled from account profile (venue name and address)
- Editable: the user can change it for events hosted elsewhere
- Display: venue name on one line, address below in muted text, with a "Change" affordance
- When changing: Google Places autocomplete
- Venue tooltip `ⓘ`: "Where is this happening? Your default venue is pre-filled from your profile."

#### Category
- Dropdown select, required
- Categories from the system (Music, Food & Drink, Arts, Community, etc.)
- No default selection — the user must choose
- Category tooltip `ⓘ`: "Pick the category that best describes your event. This helps people browsing by interest find you."

#### Tags
- Multi-select pills below category
- Tags are filtered to the selected category (category-aware)
- Optional — zero tags is valid
- Tags tooltip `ⓘ`: "Tags help people searching for specific things like 'trivia,' 'live jazz,' or 'beginner-friendly.' Pick any that apply."

#### — Visual divider —

#### Image
- Upload zone: "Drop an image or click to upload"
- After upload: the image displayed with a landscape crop overlay
- Crop tool: a band representing the visible area. User drags up/down (portrait images) or left/right (landscape images) to position what's featured
- One preview: the image as it will appear on an event card — landscape proportions designed from first principles for mobile and desktop
- Image tooltip `ⓘ`: "A photo makes your event stand out. It appears as a banner in event listings. Drag to adjust which part is featured."
- Not required, but present and inviting

#### Description
- Textarea, 3–4 lines visible
- Placeholder: "Tell people what to expect..."
- Optional
- Description tooltip `ⓘ`: "A sentence or two about what to expect. This appears in event listings and search results."

#### Price and Link
- Side by side (two columns on desktop, stacked on mobile)
- Price: text input, placeholder "Free, $10, $5–15..."
- Price tooltip `ⓘ`: "How much does it cost? Write 'Free' if there's no charge."
- Link: URL input, placeholder "https://..."
- Link tooltip `ⓘ`: "Where can people learn more or get tickets? Paste a link from Eventbrite, your website, or anywhere."

#### Publish button
- Full-width, prominent, at the bottom
- "Publish Event" for new events, "Save Changes" for edits
- Sticky on mobile so it's always reachable

### The Editing Experience

When the user returns to edit an event, the same form appears — but pre-filled with the event's current data. It's the same layout, the same fields, the same order. The user recognizes it immediately. They change what needs changing and save.

No separate "view" and "edit" modes. The form is always editable. The record is a document you read and correct, not a display you must switch into edit mode to change.

---

## The Dashboard

### Structure

Three sections, top to bottom:

#### Recurring Programming
The anchor. These are the things the business always does — their identity.

Each recurring series is a card showing:
- Event title
- Recurrence pattern in plain language ("Every Tuesday · 8 PM")
- Count: "23 upcoming"
- Next date: "Next: Apr 1"
- Actions: "Edit series" / "Edit next"

**Edit series** opens the series template — the title, time, recurrence rule, category, and any shared details. Changes here propagate to all future instances.

**Edit next** opens just the next upcoming instance for one-off overrides (different description this week, different time, etc.).

Series management questions — "change one or change all?" — are resolved by these two separate entry points. No ambiguous modal asking which you meant.

If a series is running low (fewer than 5 upcoming), a gentle indicator: "5 remaining — extend?" One-tap to add another 3 or 6 months.

#### Upcoming One-Offs
Special events, shows, one-time things. Each is a card showing:
- Event title
- Date and time
- Venue (if different from default)
- Actions: "Edit" / "Share"

Directly editable — tap "Edit" and the event form appears with this event's data.

#### History
Past events, visually muted (reduced opacity or lighter text). A record of what's been. For now, just the event data. Someday: engagement metrics ("Viewed 340 times across 3 apps").

Collapsed by default with a "Show past events" affordance if the list is long.

### Quick Add

Prominent on the dashboard — not buried in a sidebar. A clear "Post an event" button or card at the top of the page, inviting the user to create. This is the primary action and should feel like it.

### Empty State

For new users with no events yet:

A centered, calm message: "No events yet. Post your first event to reach the neighborhood." With the create button right there. No illustrations, no onboarding carousel — just the invitation and the tool.

---

## The Tooltip System

### Behavior
- **Desktop:** Hover over `ⓘ` to reveal tooltip. Tooltip appears adjacent to the icon, pointing at it. Disappears on mouse leave.
- **Mobile:** Tap `ⓘ` to reveal tooltip. Tooltip stays visible until tapped again or the user taps elsewhere.
- Tooltips are small (max 200px wide), plain text, 1–2 sentences.
- Tooltips never block the input field they describe.

### Positioning
- Tooltip appears to the right of the icon on desktop (or left if near the right edge).
- On mobile, tooltip appears below the field label as an inline expansion — no floating overlay that could be clipped.

### Content Voice
- Second person, active: "Pick the category that best describes your event."
- Concise: one short sentence explaining what, one explaining why.
- No jargon, no technical terms. "Recurrence" is never user-facing — it's "repeats."

---

## Visual Design

### Typography
- **DM Sans** — the existing font. Clean, legible, modern but warm.
- Page titles: 20–24px, weight 500
- Section headers: 13px, uppercase, letter-spacing 0.04em, muted color
- Form labels: 14px, weight 500
- Body/input text: 15px
- Helper text / tooltips: 12–13px, muted
- The type scale is intentionally small. This is a tool, not a magazine. Legibility comes from spacing and contrast, not size.

### Color
- **Light work palette** (logged-in screens): off-white background (#f7f7f5), white cards, near-black text (#37352f), warm muted grays for secondary text
- **Dark brand palette** (login/marketing only): warm beige accent (#c4b89e), dark background (#0f0f0e)
- Accent color is used sparingly — active states, the publish button, selected items. The UI is mostly neutral. Color means something when it appears.
- Error: warm red (#c0392b). Success: calm green (#2d8a4e). These are the only semantic colors.

### Spacing
- 8px base unit. All spacing is multiples: 4, 8, 12, 16, 20, 24, 32, 40.
- Generous whitespace between sections (24–32px). The form should breathe.
- Tight spacing within groups (8–12px between a label and its input).
- The overall feeling is "airy but structured." Nothing cramped, nothing floating in empty space.

### Cards and Containers
- White cards on the off-white background. 1px border in warm gray. 10–12px border radius.
- No shadows. The border is the only depth cue. This keeps the interface flat and calm.
- Cards are the primary container. Each dashboard item is a card. The form is a card (or a series of cards if visually divided into sections).

### Interactive States
- **Hover:** Subtle border darkening on cards and rows. No background color change — too noisy.
- **Focus:** 2px outline in accent color, offset 2px. Always visible on keyboard navigation.
- **Active/pressed:** Slight scale reduction (0.98) on buttons. Immediate, tactile.
- **Disabled:** Reduced opacity (0.5), cursor changes to default. Visually distinct from enabled.
- **Loading:** Button text changes ("Publishing...") with a small spinner. No full-page loading screens — skeleton placeholders for data fetches.

### Mobile
- Sidebar collapses to a hamburger menu (existing behavior).
- Form fields stack single-column.
- Publish button is sticky at the bottom of the viewport.
- Touch targets: minimum 44px height on all interactive elements.
- The form is comfortable to fill on a phone held in one hand. Inputs are full-width. Date/time pickers are large enough to tap accurately.

### Desktop
- Sidebar fixed at 240px (existing behavior).
- Form content centered at 600px max-width. This prevents lines from getting too long and keeps the form feeling intimate, not sprawling.
- Dashboard content at 800px max-width. The card grid uses `auto-fill` with `minmax(280px, 1fr)` so cards grow on wide screens rather than leaving dead space.

---

## Admin-Specific Screens

### Review Queue
The admin review queue is a data triage interface, not a CMS entry form. Different design priorities: speed, density, keyboard shortcuts.

- Candidate cards in a list (not a grid — sequential review, not browsing)
- Each card: title, date, venue, source, confidence indicator, status
- Expand a card to see full details and edit fields
- Keyboard shortcuts for power users: j/k to navigate, a to approve, r to reject
- Tab filtering by status: Pending / Approved / Rejected / Duplicate
- Batch selection with "Approve as Series" for recurring patterns detected across candidates

### Feed Sources and Newsletters
Functional admin tools. Clean table/list layouts. Standard form patterns for creating and editing sources. These don't need the same level of polish as the business-facing screens — they need to be clear and fast.

### Account Management
List of business accounts with status, event counts, activity. Detail view for each account. Impersonation mode ("act as this business") for debugging and support.

---

## Accessibility

- All form inputs have associated `<label>` elements (visible or screen-reader-only).
- All icon-only buttons have `aria-label` attributes.
- Tooltips are accessible: `aria-describedby` linking the `ⓘ` icon to the tooltip content.
- Tab navigation reaches every interactive element in logical order.
- `focus-visible` outlines on all focusable elements.
- Modals and dialogs: focus trap, Escape to close, `aria-modal`.
- Toast notifications: `role="alert"` for screen reader announcement.
- Color is never the only indicator of state — text labels accompany colored badges.
- Minimum 4.5:1 contrast ratio on all text.

---

## What This Is Not

- **Not a design system with reusable component primitives.** It's a specific product. Components are extracted when they're used more than once, not as a premature abstraction.
- **Not a theme-able or skinnable interface.** One palette, one type scale, one set of spacing. Consistency comes from having one answer, not from having a configurable framework.
- **Not innovative.** Every pattern here exists in other well-made tools. The ambition is execution quality, not novelty.

---

## Reference Points

Tools that get this feeling right, for different reasons:

- **Linear** — calm, fast, information-dense but not overwhelming. The keyboard shortcuts, the visual hierarchy, the sense of control. Feels like a native app in the browser. State changes are instantaneous.
- **Notion** — the block-based editing feel, where the document is always live and editable. The sense that you're working with the content directly, not through a form.
- **Stripe Dashboard** — premium feel from typography and spacing alone. No decorative elements. The confidence that comes from restraint. Data always presented in character — amounts look like amounts, statuses look like statuses.
- **Ghost Admin** — a CMS that respects the publisher. Clean post editor, clear content management, no bloat.

**Anti-references:**
- **Typeform** — beautiful but performative. Things move and reshape themselves in ways that entertain rather than inform. The animation is the product. We want the data to be the product.
- **WordPress** — functional but the UI doesn't communicate data types. Everything looks like a text field. A title input looks like a tag input looks like a category input. Nothing is self-reflective.
- **Squarespace editor** — polished but opaque. The UI is so abstracted from the data that users lose track of what they're actually setting. Form over function.

The portal should feel like it belongs with Linear and Stripe. Not because it copies them, but because it shares their conviction that great tools are sturdy, fast, and self-evident. The data is always legible, always presented in its true nature, and the UI is the thinnest possible layer between the user's intention and the stored truth.
