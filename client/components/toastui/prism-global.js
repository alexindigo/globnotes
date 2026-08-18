// Set the Prism global BEFORE the code-syntax-highlight plugin's -all
// bundle evaluates — the bundle registers its language grammars into
// whatever window.Prism exists at evaluation time.
import Prism from "prismjs";

window.Prism = Prism;
