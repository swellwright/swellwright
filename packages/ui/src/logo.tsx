import { Group, Text } from '@mantine/core';

/** The mark: a pointy-top hexagon cut by two parallel waves. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 40 40"
      width={size}
    >
      <polygon
        points="20,3 34.7,11.5 34.7,28.5 20,37 5.3,28.5 5.3,11.5"
        stroke="var(--mantine-color-cyan-4)"
        strokeWidth="2"
      />
      <path
        d="M11 17q4.5 -4 9 0t9 0"
        stroke="var(--mantine-color-cyan-4)"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <path
        d="M11 23.5q4.5 -4 9 0t9 0"
        stroke="var(--mantine-color-cyan-4)"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

/**
 * The brand of the header and of the sign-in screens: the mark and the title, which the panel sets in Unbounded in
 * two colors. `size` is the width of the mark in pixels (40 in the header, 48 on the sign-in screens).
 */
export function Brand({ size = 40, withTitle = true }: { size?: number; withTitle?: boolean }) {
  return (
    <Group gap="xs" style={{ flexShrink: 0 }} wrap="nowrap">
      <LogoMark className="sw-brand-mark" size={size} />
      {withTitle ? (
        <Text className="sw-brand-title" component="span">
          <Text c="cyan" component="span" inherit>
            Swell
          </Text>
          <Text c="white" component="span" inherit>
            wright
          </Text>
        </Text>
      ) : null}
    </Group>
  );
}
