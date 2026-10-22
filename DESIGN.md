# Formwright interface

A focused application workspace for someone moving through job applications at a desk during both daylight and evening sessions. Follow the system's appearance by default, with persistent Light and Dark overrides.

Use neutral slate surfaces and a restrained blue accent for the primary action, selection, and focus. Avoid green tints. Use the tokens in `web/dashboard.css`: background, surface, subtle, ink, muted, line, control, accent, error, warning and blue progress. Never hardcode light-only surfaces in components. One system sans family; 26px page headings, 13–14px controls and table text, 11–12px metadata.

Keep one page heading, no introductory slogans, and no repeated instructions. Collapse account, model, and source configuration under named disclosures. Navigation stays visible on desktop and becomes horizontal on smaller screens. The queue controls remain one compact strip beside the list. Use the checkboxes for selection and the Review queue tab for preview; avoid duplicate selection buttons. Application rows own status saves and errors; Details holds source metadata, timestamps, secondary lifecycle, removal, answers and raw results. Show Mark applied only for applications ready for review; other statuses remain editable in the status selector. Do not conflate autofill progress with submitted status. Status edits save immediately, report pending/verified/error, and never submit a form.

Keep interactions immediate. Use 100ms control feedback, no entrance choreography, no remote fonts, and reduced-motion overrides. Render 50 application rows per page. Reconcile unchanged DOM rows in place and defer inactive views. Search and navigation remain available during saves. Local state polls pause in background tabs; Notion refresh is separately visible and configurable.

All control labels must be accessible. Preserve focused fields, caret positions and draft answers when polling. Long URLs wrap; mobile cards keep all primary actions reachable. Verify both themes at desktop, tablet and narrow-phone widths with synthetic data.
