# Beat 2 — where did the money go? spending by category (interactive TUI, gemma4:31b · Aug 2026 ledger)
# Render:  vhs demos/oa-tui-summary.tape   then   bun demos/tighten.ts demos/raw/oa-tui-summary.mp4 demos/oa-tui-summary.mp4

Output demos/raw/oa-tui-summary.mp4

Require wilson
Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 820
Set Theme "Catppuccin Mocha"
Set Padding 24
Set TypingSpeed 45ms
Set Margin 20
Set BorderRadius 10

Hide
Type "export PATH=/Users/jdfiscus/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
Enter
Type "cd /Users/jdfiscus/dev/oss/openaccoutant/wilson"
Enter
Type "clear"
Enter
Show

Type "wilson --profile demo"
Sleep 400ms
Enter
# Wait until the intro actually renders (capital-P "Profile:" is intro-only) so the
# question types into a READY TUI, not the still-booting shell.
Wait+Screen@60s /Profile/
Sleep 1200ms

Type "give me a summary of my August 2026 spending by category"
Sleep 500ms
Enter
# Wait for the per-response stats line ("... tokens · (... tok/s)") = answer complete,
# then a short hold. Keeps the trailing freeze < the think-pause so tighten.ts cuts the
# right gap. (Free port 3141 / no other wilson process before rendering — see render guard.)
Wait+Screen@180s /tokens/
Sleep 3500ms
