# Third-Party Notices

This product adapts portions of the following open-source software:

## chatgpt-exporter — pionxzh — MIT License

Source: https://github.com/pionxzh/chatgpt-exporter

We adapted the conversation-mapping walking strategy (current_node → parent
chain → reverse) and the markdown export skeleton from this project.
Our implementation differs significantly: we piggyback ChatGPT's own
fetch instead of issuing API requests (ChatGPT now requires proprietary
headers including a JWT, OAI-Device-Id, OAI-Session-Id, and X-OAI-IS,
which can't reliably be reconstructed externally). We also integrate
with our timeline TurnTextCache for silent prefetch.

---

MIT License

Copyright (c) 2023 pionxzh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
