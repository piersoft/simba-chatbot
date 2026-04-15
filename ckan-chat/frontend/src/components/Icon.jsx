// Wrapper Bootstrap Icons — mai usare <i className="bi ..."> dentro stringhe JS
export default function Icon({ name, size = 16, className = "" }) {
  return (
    <i
      className={`bi bi-${name} ${className}`}
      style={{ fontSize: size, verticalAlign: "-0.125em" }}
    />
  );
}
