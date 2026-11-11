# Layout of the release disk image, for dmgbuild (run by release.sh):
#   dmgbuild -s tools/dmg-settings.py -D app=<Shield.app> -D background=<tiff> <volume name> <out.dmg>
#
# dmgbuild writes the window layout itself, so this works over SSH, where Finder can't be
# scripted. The background and the positions on it come from tools/dmg-background.swift.

import os.path

app = defines["app"]  # noqa: F821 (dmgbuild provides `defines`)

format = "UDZO"
files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(app, "Contents/Resources/AppIcon.icns")  # the mounted volume's icon

background = defines["background"]  # noqa: F821
# The background is 660 × 420; the window is taller by its title bar.
window_rect = ((200, 160), (660, 448))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

arrange_by = None
icon_size = 128
text_size = 13
icon_locations = {
    os.path.basename(app): (175, 208),
    "Applications": (485, 208),
}
