# Jarvis

<img src=img/jarvis-logo-circle.png width=70> [![DOI](https://zenodo.org/badge/568521268.svg)](https://zenodo.org/badge/latestdoi/568521268) ![downloads](https://img.shields.io/badge/dynamic/json?color=brightgreen&label=downloads&query=%24.totalDownloads&url=https%3A%2F%2Fjoplin-plugin-downloads.vercel.app%2Fapi%3Fplugin%3Djoplin.plugin.alondmnt.jarvis)

Jarvis (Joplin Assistant Running a Very Intelligent System) is an AI note-taking assistant for [Joplin](https://joplinapp.org) (desktop and [mobile](MOBILE.md)), powered by online and [offline](GUIDE.md#setup-a-custom-model) LLMs (such as OpenAI's ChatGPT or GPT-4, Hugging Face, Gemini, Universal Sentence Encoder). You can chat with it (including prompt templates), use your personal notes as additional context in the chat, automatically annotate notes, perform semantic search, or compile an [automatic review of the scientific literature](https://medium.com/@alondmnt/ai-powered-literature-review-6918ee180304).

Community discussion: https://discourse.joplinapp.org/t/28316

<img src="img/jarvis-chat-panel.png" width="300">

## Usage

- **Chat:**
    - You can chat with Jarvis in a dedicated sidebar (the **chat panel**, opened with the `Toggle chat panel` command), or inside a note. The panel has three modes, cycled with `Shift+Tab` (or by clicking the mode button): **Chat** for plain conversation, **Note** to scope the chat to the currently open note (like the `Chat with Jarvis` command), and **Collection** to ground it in your whole notes collection (like `Chat with your notes`). Click **Save** to write the conversation to a note (saving again updates the same note); you can then carry it on in the note with `Chat with Jarvis`.
    - To chat in a note instead, start a new note, or continue an existing conversation in a saved note. Place the cursor after your prompt and run the command `Chat with Jarvis` (from the toolbar or Tools/Jarvis menu). Each time you run the command Jarvis will append its response to the note at the current cursor position (given the previous content that both of you created).
- **Chat with your notes:**
    - To add additional context to your conversation based on your notes, repeat the steps above but select the command `Chat with your notes` (from the Tools/Jarvis menu) instead. Relevant short excerpts from your notes will be sent to the chat model in addition to the usual conversation prompt / context. To exclude certain notes from this feature, add the tag `jarvis-exclude` to the notes you wish to exclude. You may combine regular chat and note-based chat on the same note. For more information see [this guide](GUIDE.md#chat-with-your-notes).
- **Keep notes private:**
    - To keep notes away from Jarvis entirely, exclude them: run `Exclude note from Jarvis` on the open note, or `Exclude notebook from Jarvis (with its sub-notebooks)` on the selected notebook (Tools/Jarvis menu), or add the tag `jarvis-exclude` to a note yourself. Excluded notes are not indexed, not used as note excerpts or search results, and not accepted by the commands that send the open note's content (Chat, Autocomplete, Annotate, Edit). Excluding a notebook also covers every notebook nested inside it, including ones you add later. See [this guide](GUIDE.md#keep-notes-private-exclude-from-jarvis).
- **Related notes / semantic search:**
    - Find notes based on semantic similarity to the currently open note, to selected text, or to search queries. By default, this is done locally (offline), without sending the content of your notes to a remote server (online models can be selected). Notes are displayed in a dedicated panel. To run semantic search based on selected text, click on the `Find related notes` toolbar button or context menu option. You may also write any query in the panel's search box.
- **Annotate your notes:**
    - Run the command `Annotate note with Jarvis` to add annotations to your notes: title, summary, links and / or tags. For more information see [this guide](GUIDE.md#annotate-note-with-jarvis).
- **Literature review:**
    - Run the command `Research with Jarvis`, write what you're interested in, and optionally adjust the search parameters. Wait 2-3 minutes for all the output to appear in the note (depending on internet traffic). Jarvis will update the content as it finds new information on the web (using Semantic Scholar, Crossref, Elsevier, Springer & Wikipedia databases). In the end you will get a report with the following sections: title, prompt, research questions, queries, references, review and follow-up questions. For more information see [this post](https://medium.com/@alondmnt/ai-powered-literature-review-6918ee180304).
- **Autocomplete anything:**
    - After you stop typing for about 0.8 seconds, Jarvis can show an inline continuation at the cursor; press `Tab` to accept it. Automatic suggestions are **off until you ask for them in a note**: open the note, click the Jarvis indicator in the editor, and suggestions start there; click again to stop them. The choice is remembered **per note**, so a note you have never switched on stays quiet however long you keep it, and switching one on does not change the others. (If you would rather have notes you open for the first time start enabled, set `Autocomplete: Enable automatic suggestions in notes not opened before`; `Autocomplete: Enable automatic suggestions` is the master switch that turns the feature off in every note.) Hover the indicator to see the note's current state (a red slash means off). How much context each suggestion may use is the `Autocomplete: Maximum context characters` setting. Hovering the indicator also offers a round struck-through eye button above it that excludes the note in one click (it adds the `jarvis-exclude` tag), so a note you decide to keep private does not need a trip to the menu. On a note excluded from Jarvis the indicator shows a grey slash and explains on hover which exclusion applies; a note excluded by a tag can still be switched on for that note. `Auto-complete with Jarvis` remains available to extend text on demand.
- **Text generation:**
    - Run the command `Ask Jarvis` and write your query in the pop-up window, or select a prompt text in the editor before running the command. You can also enhance your query with predefined (or customized) prompt templates from the dropdown lists.
- **Text editing:**
    - Select a text to edit, run the command `Edit selection with Jarvis` and write your instructions in the pop-up window.

## What this fork adds

On top of upstream Jarvis, this fork gives you control over **what Jarvis is allowed to read**, and turns the autocomplete indicator into a switch you can trust.

### Keep a note or notebook away from Jarvis

An excluded note is never indexed, never returned as a related note or as chat context, and refused by the commands that would send it (`Chat`, `Chat with your notes`, `Autocomplete`, `Annotate`, `Edit`) - with a message saying why, instead of a silent send.

| How | What it covers |
|-----|----------------|
| `Exclude note from Jarvis` / `Include note in Jarvis` (Tools/Jarvis) | The open note, via the `jarvis-exclude` tag |
| `Exclude notebook from Jarvis (with its sub-notebooks)` / `Include notebook in Jarvis` | The selected notebook **and every notebook inside it**, including ones you create there later |
| The round struck-through eye button that appears when you hover the editor indicator | The note you are writing, in one click |
| Adding the `jarvis-exclude` tag yourself in Joplin | Any note, and it syncs with your notes across devices |

The indicator always tells you where you stand: a **grey** slash means the note is excluded, and hovering says whether it is a tag (which you can still switch autocomplete on for), a notebook, the trash, or a conflict note. See [the guide](GUIDE.md#keep-notes-private-exclude-from-jarvis) for the details.

### Autocomplete that stays quiet

- **Per note, off until asked.** Suggestions do not appear until you click the indicator in that note. A note you never switched on stays quiet however often you open it, and switching one on leaves the others alone. `Autocomplete: Enable automatic suggestions in notes not opened before` opts into the opposite, and `Autocomplete: Enable automatic suggestions` is the master switch.
- **One click, one switch.** The indicator is a plain toggle - no settings menu to open. Context size lives in `Autocomplete: Maximum context characters` where it belongs.
- **A privacy shortcut on hover**, the round struck-through eye button, appears only after a short hover so a pointer passing by cannot tag a note by accident.

## Installation

1. Install Jarvis from Joplin's plugin marketplace, or download this fork's build from [its releases](https://github.com/TsingLoo/joplin-jarvis/releases) (the `.jpl` file attached to the latest release).
2. Select a model for chatting with Jarvis, and a model for indexing your notes. Depending on your choice of models to connect Jarvis with, you may need to setup an API key in the plugin settings for [OpenAI](https://platform.openai.com/account/api-keys), [Google AI](https://makersuite.google.com/app/apikey), [Hugging Face](https://huggingface.co/settings/tokens), or other supported services.
3. To improve chat coherence, it may be helpful to increase `Memory tokens` in the settings, especially when chatting with your notes.
4. For literature reviews, you can optionally add free API keys for [Scopus/Elsevier](https://dev.elsevier.com/) as an additional powerful search engine and paper repository, and [Springer](https://dev.springernature.com/) as another paper repository. It is recommended to try both Scopus and Semantic Scholar as each has its pros and cons.
5. For mobile support, see [MOBILE.md](MOBILE.md).

## Disclaimer

- This plugin sends your queries to your selected models (and only to these ones, whether they are online or offline models). See the table below for details.
    - Research queries are also sent to the selected literature search engine (Semantic Scholar / Scopus).
- This plugin may use your OpenAI, Google AI or Hugging Face API key in order to do so (and use it for this sole purpose).
- You may incur charges (if you are a paying user) from these services by using this plugin.
- Therefore, it is recommended to check your usage statistics periodically.
- It is also recommended to rotate your API keys occasionally.
- The developer is not affiliated with any of the services above.

The following table shows what is sent to the selected chat / notes models when running each command.

| Command            | User prompt | Current note | Other note excerpts | All notes | Web articles |   Models    |
|--------------------|:-----------:|:------------:|:-------------------:|:---------:|:------------:|:-----------:|
| Ask Jarvis         |      x      |              |                     |           |              |    chat     |
| Chat               |      x      |      x       |                     |           |              |    chat     |
| Chat w/ notes      |      x      |      x       |          x          |           |              | chat, notes |
| Research           |      x      |              |                     |           |      x       |    chat     |
| Edit               |      x      |              |                     |           |              |    chat     |
| Autocomplete       |             |      x       |                     |           |              |    chat     |
| Annotate note      |             |      x       |          x          |           |              | chat, notes |
| Find related notes |             |      x       |                     |           |              |    notes    |
| Update note DB     |             |              |                     |     x     |              |    notes    |
