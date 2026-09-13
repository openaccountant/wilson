# FLOW 2 — open the slash palette, arrow through options, then run a skill.
# Skill = spending-review (verified to COMPLETE on granite4.1:8b in ~43s in May;
# re-time on gemma4:31b before recording and size the two sleeps from that).
# Frame the video on the palette + the multi-tool execution; its closing prose
# can drift, so speed past / caption the tail in post.
Output data/demo/flow2-skill.gif
Output data/demo/flow2-skill.mp4
Set Shell zsh
Set FontSize 18
Set Width 1400
Set Height 860
Set Padding 24
Set TypingSpeed 120ms
Set Theme { "name": "ForensicNoir", "background": "#0a0f1a", "foreground": "#e5e7eb", "cursor": "#22c55e", "selection": "#166534" }

Type "./data/demo/run-showcase.sh"
Enter
Sleep 8s
Screenshot data/demo/f2-00-boot.png

# open the palette and browse it
Type "/"
Sleep 1500ms
Down
Sleep 700ms
Down
Sleep 700ms
Down
Sleep 700ms
Screenshot data/demo/f2-01-palette.png

# dismiss the palette, then run a skill explicitly
Escape
Sleep 500ms
Type "/skill spending-review"
Sleep 800ms
Enter
Sleep 30s
Screenshot data/demo/f2-02-running.png
Sleep 25s
Screenshot data/demo/f2-03-report.png
Sleep 2s
