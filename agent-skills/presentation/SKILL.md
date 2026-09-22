---
name: presentation
description: Show something on screen while you talk (the network's main display, or your own screen when none is set) — a single page (a chart, a table, search results, a dashboard) or a multi-slide deck that advances in time with your narration. Use whenever a visual would say it better than speech alone; that call is yours to make on any turn, without being asked. Not for a short answer that needs no picture.
---

# Showing things on screen

## First, look at the screen

Read `{{SKILL_DIR}}/display.md`. It says which screen a presentation appears on right now — the
network's main display, or your own screen when none is set — which folder to write pages into,
and how to name a page in the marker.

## Design for that screen

`display.md` also says what kind of screen it is — phone, tablet or large — and roughly how long its
short and long side are. It does not say which way up the screen is held: a phone gets turned, so a
deck for a phone has to work both ways. Design for it:

- **A phone:** one column. Stack what would sit side by side on a big screen. Short headings, at
  most three bullets, fewer words overall — your narration carries the detail.
- **A tablet:** one column for anything dense; two only for a picture beside a short caption.
- **A large screen:** room for two columns, a chart beside its takeaway, more on a slide.
- **Size unknown:** design so it also works on a phone.

Whatever the screen, size things relatively — `%`, `vw`, `clamp()` — and never give a box a fixed
pixel width or height. A deck gets clicked through again later, maybe somewhere else, and fixed
sizes are what break it. A slide that still ends up too big is scaled down to fit rather than cut
off; that is a safety net, not something to design for.

## A single page

Append this at the very end of your reply, after any FORWARD marker, exactly once:

[PRESENTATION: <file name or website address>]

The page appears on that screen while your reply is spoken. Whether a visual is worth it is
your own call on every turn — nobody will ask for it. Once you present, the usual brevity does not
apply: narrate at proper length, since the content runs alongside.

If there is no ready page, write a small self-contained HTML file into the folder named in
`display.md` and put just its file name in the marker, for example [PRESENTATION: tides.html].
Built a page on the same topic earlier in this conversation? Name the same file again instead of
writing a new one.

Self-contained means exactly that: the file is carried to the screen on its own, so other files next
to it in the folder never arrive. Pictures come from the web by their full address, or are embedded
as `data:` URLs. The page cannot load anything else from your machine, cannot store anything in the
browser, and cannot embed other websites that need a login or cookies — a video player stays black.
To show a website or a video, present its own address instead of wrapping it in a page.

## Several parts: a deck

A deck is for content that genuinely has *parts*: slides you talk through, each one appearing
exactly when you start talking about it.

## Decide first whether it's actually a deck

Several slides are worth it when the content is a **sequence** — steps in a process, options being
compared, findings in order, a plan with stages. The slides then carry information that a single
page would have to flatten.

Stay with a single page for one chart, one table, one number, one short answer. A three-slide deck
for a one-sentence answer is worse than no deck at all, and it makes you talk longer than you need
to. If you catch yourself padding narration to justify the slide count, it should have been one page.

## How it works

You write **one HTML file** with several `<section>` elements, and split your spoken reply with a
slide marker where each slide ends. Segment *i* of your speech is spoken while slide *i* is on
screen, and the deck advances by itself in the pause between segments. The listener can also click
or arrow-key through it afterwards — that comes for free, you don't have to build it.

The slide marker is [SLIDE]. Write it as bare text in the middle of your reply — never in backticks,
never bold, never on a line of its own. It is stripped out before anything is spoken, and any
formatting you wrap around it is left behind to be read out loud.

The number of markers has to match the deck: **N sections means N−1 markers.** Before you send the
reply, literally count both — sections in the file, markers in the narration — and check the
difference is exactly one.

The trap is the title slide. It is a slide like any other, so it needs its own opening line of
narration before the first marker. Getting this wrong is the mistake that actually shows: every
slide after it lags one behind, and you end up talking about the last point while the screen is
still on the second-to-last.

```text
WRONG   4 sections (title + 3 stages), only 2 markers
        "Three stages. First, orientation... [SLIDE] Second, integration...
         [SLIDE] Third, full ramp-up..."
         -> the title slide is on screen while you talk about stage one

RIGHT   4 sections, 3 markers -- the title gets its own line
        "Here's how onboarding works. [SLIDE] First, orientation...
         [SLIDE] Second, integration... [SLIDE] Third, full ramp-up..."
```

If you'd rather not open with a separate line, drop the title section and start straight at the
first real slide. Four sections narrated as three is the one thing that must not happen.

## Writing the deck

Write the file into the folder named in `display.md` and name it in the marker by its file name.

Link the two files every machine on this network serves at `/deck.css` and `/deck.js`. They handle
the paging mechanics — which slide is visible, the progress bar, keyboard, swipe, the arrows, and
receiving the advance signal while you speak. Those are root-relative paths on purpose: they
resolve against whichever machine shows the deck, and every machine has them.

Never reimplement the paging JavaScript — that is what makes the deck advance in time with your
voice, and a hand-rolled version will not receive the signal.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Q3 pipeline</title>
<link rel="stylesheet" href="/deck.css">
</head>
<body>
<div class="deck">

  <section class="deck-title">
    <h1>Q3 pipeline</h1>
    <p>Three things worth knowing before Thursday</p>
  </section>

  <section>
    <h3>Where it stands</h3>
    <h2>Up 18% on Q2</h2>
    <ul>
      <li><strong>41 open deals</strong>, up from 34</li>
      <li>Average size flat at <strong>€12k</strong></li>
    </ul>
  </section>

  <section>
    <h3>The catch</h3>
    <h2>Most of it lands in one week</h2>
    <table>
      <tr><th>Week</th><th>Closing</th></tr>
      <tr><td>Sep 8</td><td>€41k</td></tr>
      <tr><td>Sep 15</td><td>€186k</td></tr>
      <tr><td>Sep 22</td><td>€38k</td></tr>
    </table>
  </section>

</div>
<script src="/deck.js"></script>
</body>
</html>
```

Three sections, so the reply carries two markers. Written exactly like this, plain and unformatted:

```text
Here's where the Q3 pipeline stands ahead of Thursday. [SLIDE] It's up eighteen percent on Q2, with
forty-one open deals and average deal size holding at twelve thousand. [SLIDE] The catch is the
concentration — a hundred and eighty-six thousand of it closes in the single week of the fifteenth,
so that week is the whole quarter. [PRESENTATION: q3-pipeline.html]
```

### Markup that works

Plain elements are styled for you: `h1`, `h2`, `h3` (renders as a small accent eyebrow above the
heading), `p`, `ul`/`ol`, `table`, `pre`/`code`, `blockquote`, `img`, `strong`, `em`. Add
`class="deck-title"` to a section for a centered title slide. You don't need any other classes.

Keep each slide to **one idea** — a heading and three or four bullets at most. This is read from
across a room, and anything you'd have to squint at belongs in the narration instead, not on the
slide. Never write speaker notes onto a slide: what you say and what's on screen are two different
channels, and duplicating one into the other wastes both.

## Now make it look like something

`/deck.css` is a floor, not a ceiling. It exists so a deck is never *broken* — not so every deck
looks the same. A deck that ships with nothing but the defaults looks like a template, and that is
a worse presentation than a single well-designed page would have been.

So design it, the way you would design a one-page presentation: **give this particular subject its
own look.** Add a `<style>` block in the head, after the `<link>`. Everything visual in `/deck.css`
is written with zero specificity, so plain selectors like `h1 { ... }` override it cleanly — no
`!important`, no fighting.

Re-theming the whole deck is five lines, and it is the cheapest thing you can do that makes a deck
look considered:

```html
<style>
  :root {
    --deck-bg: #0e0b14;          /* page background */
    --deck-bg-accent: #1a1226;   /* subtle glow behind the slide */
    --deck-fg: #f4f1f7;          /* body text */
    --deck-muted: #a99fb5;       /* secondary text, table headers */
    --deck-accent: #e0a3ff;      /* eyebrows, bullets, progress bar, arrows */
    --deck-line: #332b40;        /* rules and borders */
    --deck-surface: #1c1626;     /* code blocks, buttons */
  }
</style>
```

Pick the palette from the subject itself — a finance deck is not a wildlife deck is not an incident
report. Then go further where it earns its keep:

- **Draw the data.** Inline SVG or styled `<div>` bars beat a table for anything comparative. A bar
  chart you built out of five divs reads instantly from across a room; a table of the same numbers
  does not.
- **Give one slide a different shape.** A big single number, a two-column split, a full-bleed
  quote. Uniformity across every slide is what makes a deck feel like a form.
- **Let one thing dominate each slide.** The point of a slide should be legible in a second.

Keep it restrained and consistent — one accent color used deliberately, not five. And keep contrast
high: this is displayed on someone else's screen, in a room you cannot see.

## The reply itself

- Put `[PRESENTATION: <file name>]` at the very end, exactly once, as always.
- The usual terseness doesn't apply once you're presenting — narrate at proper length.
- Narrate *around* the slide, don't read it out. The slide shows the numbers; you say what they mean.
- Reusing a deck you already built earlier in this conversation? Name the same file again and
  don't write a new file — but re-send the slide markers, since the narration is new each time.
