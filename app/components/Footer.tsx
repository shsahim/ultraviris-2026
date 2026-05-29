export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer
      style={{
        marginTop: "auto",
        paddingTop: "2rem",
        fontSize: "0.85rem",
        color: "#777777",
        textAlign: "center",
      }}
    >
      &copy; {year} Ultraviris LLC. All rights reserved.
    </footer>
  );
}
