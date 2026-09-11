# Daily Bible Study

A daily Bible study published as a simple, mobile-friendly web page. Each day covers a focused passage with verse-by-verse commentary, real-world application, and reflection questions.

**Live site:** [blessedcontent.github.io/bible-study](https://blessedcontent.github.io/bible-study/)

## Repo structure

- **Root** — Published daily study HTML files (one per day, named by date)
- **staging/** — Upcoming studies queued for auto-publish
- **assets/** — Current content-hashed reader assets, plus the documented v4.9/v5.0 stylesheet rollback set
- **.github/workflows/** — Auto-publish and notification workflows (checked at :07 and :37 each hour in Central time)

The active v5.1.0 asset contract is recorded in `asset-manifest-v5_1_0.json`.
Older JavaScript, icons, and social-card files are recovered from Git history if
a rollback is needed. Only `study-v4_9.css`, `study-v5_0.css`, and their two
image dependencies remain beside the active assets as an immediate stylesheet
rollback set.
