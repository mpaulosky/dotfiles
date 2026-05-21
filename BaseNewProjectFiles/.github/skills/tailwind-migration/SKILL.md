---
name: tailwind-migration
description: "Migrate a Blazor project from Bootstrap to Tailwind CSS with light/dark themes using red, blue, green, and yellow color palettes. Replaces side navigation with a top menu bar. Applies modern styling throughout all pages and layout components. Use when: converting Bootstrap to Tailwind, adding dark mode, theming Blazor app, updating navigation layout, modernizing UI."
---

# Tailwind CSS Migration — Bootstrap → Tailwind + Themes

Migrates the **MyBlog** Blazor project from Bootstrap to Tailwind CSS v4+ with:

- Light / dark mode toggle
- Four color themes: Red, Blue, Green, Yellow
- Top navigation bar (replacing sidebar)
- Modern card/typography styling on all pages

## When to Use

- Converting Bootstrap classes to Tailwind utilities in Blazor components
- Adding Tailwind-based light/dark mode with `class="dark"` strategy
- Setting up color-theme switching (red / blue / green / yellow)
- Replacing `NavMenu.razor` sidebar with a horizontal top bar
- Modernizing `Home.razor`, `Counter.razor`, `Weather.razor`, `Error.razor`, `NotFound.razor`

---

## Procedure

### Step 1 — Explore the project

Read the following files to understand current state before making changes:

- `Web/Components/Layout/MainLayout.razor`
- `Web/Components/Layout/NavMenu.razor`
- `Web/Components/Layout/MainLayout.razor.css`
- `Web/Components/Layout/NavMenu.razor.css`
- `Web/Components/Pages/Home.razor`
- `Web/Components/Pages/Counter.razor`
- `Web/Components/Pages/Weather.razor`
- `Web/Components/App.razor`
- `Web/wwwroot/app.css`
- `Web/Web.csproj`

### Step 2 — Install Tailwind CSS via CLI

Use the **Tailwind CLI** to compile Tailwind CSS into a static file referenced by the Blazor app.

**2a — Create `package.json` at the solution root:**

```json
{
  "name": "myblog",
  "private": true,
  "scripts": {
    "tw:build": "tailwindcss -i ./Web/wwwroot/app.css -o ./Web/wwwroot/tailwind.css --minify",
    "tw:watch": "tailwindcss -i ./Web/wwwroot/app.css -o ./Web/wwwroot/tailwind.css --watch"
  },
  "devDependencies": {
    "tailwindcss": "^3.4.0"
  }
}
```

**2b — Install and initialise:**

```bash
npm install
npx tailwindcss init
```

**2c — Configure `tailwind.config.js` at solution root:**

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './Web/Components/**/*.{razor,html}',
    './Web/wwwroot/index.html',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

**2d — Add Tailwind directives to the top of `Web/wwwroot/app.css`:**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**2e — Build the output CSS:**

```bash
npm run tw:build
```

During development, run `npm run tw:watch` in a separate terminal alongside `dotnet run`.

**2f — Reference the compiled CSS in `Web/Components/App.razor`:**

Replace the Bootstrap `<link>` with:

```html
<link rel="stylesheet" href="tailwind.css" />
```

Remove the Bootstrap CSS link from `<head>` (typically `lib/bootstrap/dist/css/bootstrap.min.css`).

**2g — Integrate into .NET build (optional but recommended):**

Add a build target to `Web/Web.csproj` so `tailwind.css` is regenerated on every `dotnet build`:

```xml
<Target Name="BuildTailwind" BeforeTargets="Build">
  <Exec Command="npm run tw:build" WorkingDirectory="$(SolutionDir)" />
</Target>
```

### Step 3 — Replace `app.css`

Replace `Web/wwwroot/app.css` content with the stylesheet from [./references/app.css](./references/app.css).

Key sections:

- CSS custom properties for four themes (red/blue/green/yellow) on `:root` and `.dark`
- `.theme-red`, `.theme-blue`, `.theme-green`, `.theme-yellow` selector blocks
- Base resets compatible with Tailwind's `preflight`
- Blazor error boundary styles (no Bootstrap dependency)

### Step 4 — Rewrite `MainLayout.razor`

Replace with layout from [./references/MainLayout.razor](./references/MainLayout.razor).

Structure:

```
<div class="min-h-screen bg-base text-base-content {theme-class}">
  <TopNav />          ← new top navigation
  <main class="mx-auto max-w-7xl px-4 py-8">
    @Body
  </main>
  <footer>...</footer>
</div>
<div id="blazor-error-ui">...</div>
```

Remove `MainLayout.razor.css` (all styles move to Tailwind utilities).

### Step 5 — Rewrite `NavMenu.razor` as a top bar

Replace sidebar `NavMenu.razor` with a horizontal top navigation bar.
See template in [./references/NavMenu.razor](./references/NavMenu.razor).

Key features:

- Fixed top bar using `fixed top-0 left-0 right-0 z-50`
- Responsive hamburger for mobile (`md:hidden`)
- Brand/logo on the left, nav links in the center/right
- Theme color switcher (four colored dots)
- Light/dark toggle button using `document.documentElement.classList.toggle('dark')`
- Active link highlighted with `NavLinkMatch.All`

Remove `NavMenu.razor.css`.

### Step 6 — Update all pages

Apply Tailwind utility classes and theme-aware styling to each page:

| Page             | Key changes                                                 |
| ---------------- | ----------------------------------------------------------- |
| `Home.razor`     | Hero section, feature cards with shadow and rounded corners |
| `Counter.razor`  | Centered card layout, primary button using theme color      |
| `Weather.razor`  | Responsive table with striped rows, loading skeleton        |
| `Error.razor`    | Alert card with red accent                                  |
| `NotFound.razor` | Centered 404 message with illustration                      |

See page templates in [./references/pages/](./references/pages/).

### Step 7 — Add theme + dark mode JavaScript

Add an inline `<script>` block (or `app.js`) that:

1. Reads saved theme from `localStorage` and applies class to `<html>`
2. Reads saved color theme (`theme-red` etc.) and applies to `<body>`
3. Exposes `window.setTheme(color)` and `window.toggleDark()` for Blazor JS interop

```javascript
(function () {
  const dark = localStorage.getItem("darkMode") === "true";
  if (dark) document.documentElement.classList.add("dark");
  const theme = localStorage.getItem("colorTheme") || "theme-blue";
  document.body.classList.add(theme);
  window.setTheme = (t) => {
    ["theme-red", "theme-blue", "theme-green", "theme-yellow"].forEach((c) =>
      document.body.classList.remove(c),
    );
    document.body.classList.add(t);
    localStorage.setItem("colorTheme", t);
  };
  window.toggleDark = () => {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("darkMode", isDark);
  };
})();
```

### Step 8 — Clean up Bootstrap artifacts

- Delete or empty `Web/wwwroot/lib/bootstrap/`
- Remove any Bootstrap class references (`navbar`, `btn`, `container`, `col-*`, `row`, etc.)
- Remove `bootstrap.bundle.min.js` script tags from `App.razor`
- Remove scoped CSS files that are now empty (`*.razor.css` for Layout files)

### Step 9 — Verify

1. Build: `dotnet build`
2. Run: `dotnet run --project Web`
3. Confirm:
   - Top navigation renders (no sidebar)
   - Light/dark toggle works and persists on reload
   - All four color themes apply correctly
   - Mobile hamburger menu works
   - Pages render without Bootstrap-related errors

---

## Theme Color Reference

| Theme  | Primary   | Accent    | Tailwind base color         |
| ------ | --------- | --------- | --------------------------- |
| Red    | `#dc2626` | `#fca5a5` | `red-600` / `red-300`       |
| Blue   | `#2563eb` | `#93c5fd` | `blue-600` / `blue-300`     |
| Green  | `#16a34a` | `#86efac` | `green-600` / `green-300`   |
| Yellow | `#ca8a04` | `#fde68a` | `yellow-600` / `yellow-200` |

Dark mode background: `gray-900`, surface: `gray-800`, text: `gray-100`  
Light mode background: `gray-50`, surface: `white`, text: `gray-900`

---

## Files to Create / Modify

| File                                         | Action                                     |
| -------------------------------------------- | ------------------------------------------ |
| `Web/Components/App.razor`                   | Add Tailwind script/link, remove Bootstrap |
| `Web/wwwroot/app.css`                        | Replace with Tailwind + CSS vars           |
| `Web/Components/Layout/MainLayout.razor`     | Rewrite with top-nav layout                |
| `Web/Components/Layout/NavMenu.razor`        | Rewrite as horizontal top bar              |
| `Web/Components/Layout/MainLayout.razor.css` | Delete (empty)                             |
| `Web/Components/Layout/NavMenu.razor.css`    | Delete (empty)                             |
| `Web/Components/Pages/Home.razor`            | Modernize with Tailwind                    |
| `Web/Components/Pages/Counter.razor`         | Modernize with Tailwind                    |
| `Web/Components/Pages/Weather.razor`         | Modernize with Tailwind                    |
| `Web/Components/Pages/Error.razor`           | Modernize with Tailwind                    |
| `Web/Components/Pages/NotFound.razor`        | Modernize with Tailwind                    |
| `Web/wwwroot/lib/bootstrap/`                 | Delete directory                           |
