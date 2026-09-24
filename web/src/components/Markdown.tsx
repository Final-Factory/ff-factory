import { memo, useRef, type ComponentProps } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
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

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
