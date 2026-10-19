- **The people-messages bubble, round two** (w1546, after the design critic's review). On a phone, the conversation
  header's model chip no longer draws "Opus 5.5 (configured)" over the title: it gives way first and is cut with an
  ellipsis, and "(configured)" shows only on a wider screen (the italics still mark it). The sidebar's unread count now
  follows the bubble while a clear can still be undone. After Undo, Clear all, which comes back under the pointer, shows
  no hover and ignores a second tap for a moment. The mock backend's `MOCK_PEOPLE_MESSAGES=many` puts eight unread
  messages in Ben's chat. Needs a portal deploy.
