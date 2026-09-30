import sys
from pathlib import Path

# release_post.py lives one directory up and isn't an installed package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
