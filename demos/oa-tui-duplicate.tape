# Beat 1 — "follow the money": catch a duplicate charge (interactive TUI, granite4.1:8b)
# Render:  vhs demos/oa-tui-duplicate.tape   then   bun demos/tighten.ts demos/raw/oa-tui-duplicate.mp4 demos/oa-tui-duplicate.mp4

Output demos/raw/oa-tui-duplicate.mp4

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
Enter
Sleep 6s

Type "find any duplicate charges in my May transactions"
Sleep 500ms
Enter
# Wait for the per-response stats line ("... tokens · (... tok/s)") = answer complete.
Wait+Screen@180s /tokens/
Sleep 3500ms
