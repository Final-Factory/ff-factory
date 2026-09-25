import { memo, useRef, type ComponentProps } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './ui';

/** A fenced code block under a slim bar with its language and a Copy button. */
function CodeBlock({ node, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const ref = useRef<HTMLPreElement>(null);
  const code = node?.children?.[0];
  const cls = code && 'properties' in code ? String(code.properties?.className ?? '') : '';
  const lang = /language-([\w#+.-]+)/.exec(cls)?.[1];
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang ?? 'code'}</span>
        <CopyButton getText={() => ref.current?.innerText.replace(/\n$/, '') ?? ''} label="Copy code" />
      </div>
      <pre ref={ref} {...props} />
    </div>
  );
}

/** A file path on this host or a Mac (C:\\x, F:/x, /Users/x), not a URL. */
const isLocalPath = (url: string) => {
  let u = url;
  try {
    u = decodeURIComponent(url); // markdown percent-encodes the backslashes of "C:\x"
  } catch {
    // not encoded
  }
  return /^[a-zA-Z]:[\\/]/.test(u) || /^\/(?!\/)/.test(u);
};

/**
 * Keep local paths as they are (the default would blank "F:\\…" as an unknown "f:" scheme). A local image
 * is shown by the thumbnail strip under the message (MentionedImages), through the authenticated /api/image.
 */
const urlTransform = (url: string) => (isLocalPath(url) ? url : defaultUrlTransform(url));

const components: Components = {
  a: ({ node: _node, ...props }) => (props.href && isLocalPath(props.href) ? <code>{props.children}</code> : <a {...props} target="_blank" rel="noreferrer noopener" />),
  img: ({ node: _node, ...props }) => (typeof props.src === 'string' && isLocalPath(props.src) ? null : <img {...props} alt={props.alt ?? ''} loading="lazy" />),
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  ),
  pre: CodeBlock,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
