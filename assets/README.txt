Menu image
==========

Put a JPEG at assets/menu.jpg to use it as the .menu card.

Resolution order for the .menu command:
  1. assets/menu.jpg            (this directory)
  2. MENU_IMAGE_URL from .env   (used as a remote URL)
  3. plain text menu            (final fallback)

Both the local path and the remote URL are optional; without either, .menu is
sent as text. The path is resolved relative to the project directory, so the bot
finds the image no matter which directory it is started from.
